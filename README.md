# Nanoclaw Assistant

## Log Analysis

All container calls and their token usage are logged in `logs/token-usage.jsonl`. Each line is a JSON object with details about the call, including timestamps, prompts, and costs.

* Pretty-print all entries: `cat logs/token-usage.jsonl | jq .`
* Cost per run, with message preview: `jq '{ts, group, cost: .totalCostUsd, prompt: .promptPreview}' logs/token-usage.jsonl`
* Total cost to date: `jq -s '[.[] | .totalCostUsd] | add' logs/token-usage.jsonl`
* Cache hit rate (high cache_read = efficient) `jq '{cached: .usage.cache_read_input_tokens, fresh: .usage.input_tokens}' logs/token-usage.jsonl`