/**
 * dsh-deepseek-usage
 *
 * DeepSeek usage monitor for DeepSeek Harness. Registers two model-callable
 * tools:
 *
 * - `deepseek_balance` — queries the DeepSeek API account balance
 *   (`GET /user/balance`), with an optional low-balance warning.
 * - `usage_summary` — aggregates per-session token usage from the harness
 *   token meter across live sessions.
 *
 * Both tools degrade gracefully: balance requires an API key (resolved through
 * `ctx.credentials` first, then the environment); usage summary falls back to
 * a readable explanation when the token meter or session store is absent.
 *
 * @module dsh-deepseek-usage
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
// Type-only: makes ctx.sessions / ctx.tokenMeter / ctx.credentials visible.
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-token-meter'

export const name = 'deepseek-usage'
export const inject = ['tools']

/** Plugin configuration. */
export interface Config {
  /**
   * Environment variable or credential reference holding the DeepSeek API
   * key. Resolved through `ctx.credentials` first, then the environment.
   */
  apiKeyEnv: string
  /** DeepSeek API base URL; the balance endpoint is `GET /user/balance`. */
  baseURL: string
  /**
   * Optional low-balance threshold. When the account's primary currency total
   * falls below this amount, `deepseek_balance` appends a warning line. Omit
   * to disable.
   */
  lowBalanceThreshold?: number
}

export const Config: Schema<Config> = Schema.object({
  apiKeyEnv: Schema.string().default('DEEPSEEK_API_KEY'),
  baseURL: Schema.string().default('https://api.deepseek.com'),
  lowBalanceThreshold: Schema.number(),
})

/** Resolve the API key through the credential seam, then the environment. */
async function resolveApiKey(ctx: Context, ref: string): Promise<string | undefined> {
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    const hit = await credentials.resolve(ref)
    if (hit) return hit.value
  }
  return process.env[ref]
}

interface BalanceInfo {
  currency: string
  total_balance: string
  granted_balance: string
  topped_up_balance: string
}

interface BalanceResponse {
  is_available: boolean
  balance_infos: BalanceInfo[]
}

export function apply(ctx: Context, config: Config) {
  ctx.tools.register(defineTool({
    name: 'deepseek_balance',
    description: 'Query the DeepSeek API account balance (GET /user/balance). Returns availability, per-currency total/granted/topped-up balances, and an optional low-balance warning when below the configured threshold.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          is_available: { type: 'boolean', description: 'Whether the balance is sufficient for API calls' },
          balance_infos: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                currency: { type: 'string' },
                total_balance: { type: 'string' },
                granted_balance: { type: 'string' },
                topped_up_balance: { type: 'string' },
              },
            },
          },
          warning: { type: 'string', description: 'Optional low-balance warning' },
          error: { type: 'string', description: 'Optional error message' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute() {
      const key = await resolveApiKey(ctx, config.apiKeyEnv)
      if (!key) {
        return {
          error: `DeepSeek API key not found (env/credential "${config.apiKeyEnv}"). Set DEEPSEEK_API_KEY or configure credentials.`,
        }
      }
      const url = `${config.baseURL.replace(/\/$/, '')}/user/balance`
      try {
        const res = await fetch(url, {
          headers: {
            Authorization: `Bearer ${key}`,
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(15_000),
        })
        if (!res.ok) {
          return { error: `Balance request failed: HTTP ${res.status} ${res.statusText}` }
        }
        const data = (await res.json()) as BalanceResponse
        const result: Record<string, unknown> = {
          is_available: data.is_available,
          balance_infos: data.balance_infos,
        }
        if (config.lowBalanceThreshold !== undefined && data.balance_infos.length > 0) {
          const primary = data.balance_infos[0]
          const total = Number(primary?.total_balance)
          if (Number.isFinite(total) && total < config.lowBalanceThreshold) {
            result.warning = `⚠ Low balance: ${primary?.total_balance} ${primary?.currency} (below threshold ${config.lowBalanceThreshold}). Top up to avoid task interruptions.`
          }
        }
        return result
      } catch (err) {
        return { error: `Balance request failed: ${err instanceof Error ? err.message : String(err)}` }
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'usage_summary',
    description: 'Summarize token usage across live sessions using the harness token meter. Returns per-session surface tokens, request-and-response pressure, and a grand total. Useful for estimating context usage and spotting runaway sessions.',
    parameters: {
      maxSessions: {
        type: 'number',
        description: 'Cap the number of sessions reported (default 20, sorted by total tokens descending)',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessions: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                surfaceTokens: { type: 'number' },
                totalTokens: { type: 'number' },
                logRevision: { type: 'number' },
              },
            },
          },
          grandTotalTokens: { type: 'number' },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      const sessions = ctx.get('sessions')
      const tokenMeter = ctx.get('tokenMeter')
      if (!sessions || !tokenMeter) {
        return {
          sessions: [],
          grandTotalTokens: 0,
          note: 'Token meter or session store is not available in this deployment; usage tracking is disabled.',
        }
      }
      const max = Math.max(1, Math.min(100, args.maxSessions ?? 20))
      const rows: Array<{ id: string; surfaceTokens: number; totalTokens: number; logRevision: number }> = []
      let grand = 0
      for (const session of sessions.list()) {
        try {
          const m = tokenMeter.measure(session)
          rows.push({
            id: session.id,
            surfaceTokens: m.surfaceTokens,
            totalTokens: m.totalTokens,
            logRevision: m.logRevision,
          })
          grand += m.totalTokens
        } catch {
          // A session whose log cannot be measured is skipped; the summary
          // still reflects every measurable session.
        }
      }
      rows.sort((a, b) => b.totalTokens - a.totalTokens)
      return {
        sessions: rows.slice(0, max),
        grandTotalTokens: grand,
        note: rows.length > max
          ? `Showing top ${max} of ${rows.length} sessions by total tokens.`
          : undefined,
      }
    },
  }))
}
