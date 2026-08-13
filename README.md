# dsh-deepseek-usage

DeepSeek usage monitor for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): account balance query and live token usage summary as model-callable tools.

## Install

```sh
dsh plugin --profile <name> add dsh-deepseek-usage
```

Requires a DeepSeek API key available as `DEEPSEEK_API_KEY` (env or credential).

## Tools

### `deepseek_balance`
Queries `GET https://api.deepseek.com/user/balance` and returns availability and per-currency balances (total / granted / topped-up). When `lowBalanceThreshold` is configured, appends a warning when the primary currency balance drops below it.

### `usage_summary`
Aggregates per-session token usage from the harness token meter across live sessions, sorted by total tokens descending. Use it to estimate context usage and spot runaway sessions.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `apiKeyEnv` | `DEEPSEEK_API_KEY` | Env var or credential reference for the API key |
| `baseURL` | `https://api.deepseek.com` | DeepSeek API base URL |
| `lowBalanceThreshold` | — | Optional low-balance warning threshold |

```yaml
# profile cordis.patch.yml
- id: deepseek-usage
  config:
    apiKeyEnv: DEEPSEEK_API_KEY
    lowBalanceThreshold: 20
```

## License

MIT
