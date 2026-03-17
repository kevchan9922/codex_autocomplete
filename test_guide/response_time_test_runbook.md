# Response Time CLI Runbook

## Command

```bash
npm run response:test:cli -- --workspace .
```

## Auth resolution order

1. `--token`
2. `TAB_AUTOCOMPLETE_BEARER_TOKEN`
3. `test/artifacts/oauth_test_token.txt`
4. `test_files/oauth_test_token.txt`
5. `OPENAI_API_KEY`

## Runtime alignment (hotkey-to-ghost-text)

Default mode is `hotkey_inline`, which mirrors extension runtime:

1. context build (`buildCompletionContext`)
2. stage request build (`buildStageRequests`)
3. provider stream call (`createAIProvider` -> `CodexProvider`)
4. fast/full pipeline + retries (`runHotkeyGhostTextFlow`)
5. ghost-text post-processing (`postProcessGhostTextSuggestion`)

Use `--benchmark-mode automatic_direct` only for baseline comparison.

## Useful options

- `--input-file <path>` dataset
- `--runs <n>` repeat samples
- `--log-level <debug|info|warn|error|off>`
- `--endpoint <url>` / `--model <name>`
