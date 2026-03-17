# Development Workflow

1. Run a fast local validation loop while editing:

   ```bash
   npm run compile
   npm test
   ```

   Use `npm run test:benchmark-alignment` when you want a focused check for the staged hotkey benchmark path, request-body logging, and debug-context payload alignment without rerunning the entire suite.

2. Run the critical automated gate before merging:

   ```bash
   npm run bulk:test:critical
   ```

3. Follow the test playbook in [test_guide/README.md](test_guide/README.md).
   It defines the recommended order and which file to use for each test goal.

   Trigger note: default `codexAutocomplete.triggerMode` is `hotkey`.
   Use `Codex Autocomplete: Debug Trigger Hotkey`, `Option+Tab`, or `Ctrl+Option+Space` to manually trigger suggestions.

4. Run bulk autocomplete test from CLI (no Extension Development Host):

   ```bash
   TAB_AUTOCOMPLETE_BEARER_TOKEN="<token>" npm run bulk:test:cli -- --workspace .
   ```
   or
   ```bash
   OPENAI_API_KEY="<sk-...>" npm run bulk:test:cli -- --workspace .
   ```

   `bulk:test:cli` now defaults to the staged hotkey pipeline and `scope-mode=file`, so the terminal benchmark follows the same fast/full request flow used by manual hotkey-triggered ghost text.

5. Run response-time tests and compare against the previous run:

   ```bash
   npm run response:test:cli -- --workspace .
   npm run response:test:compare-last -- --workspace .
   ```

   `response:test:cli` also defaults to the staged hotkey pipeline. Use `--benchmark-mode automatic_direct` only when you want a single-request baseline.

6. Get an OAuth bearer token from terminal (no Extension Development Host):

   ```bash
   npm run oauth:token
   ```

   This prints an `access_token` you can export as:

   ```bash
   export TAB_AUTOCOMPLETE_BEARER_TOKEN="<access_token>"
   ```

## Extensibility

Provider creation is centralized in `src/api/providerFactory.ts`, so swapping AI providers is a focused wiring change.

Inline completion helper logic is split into focused modules to keep `inlineProvider` changes reviewable:
- `src/completion/promptCacheKey.ts`
- `src/completion/abortUtils.ts`
- `src/completion/inlineTelemetry.ts`

## Runtime flow (maintainer reference)

Hotkey trigger to ghost text render:

1. `codexAutocomplete.triggerHotkey` marks explicit manual trigger state.
2. Inline provider builds cursor/file context and two-stage requests (`fast` then `full`).
3. Provider streams SSE from Codex endpoint and parses `response.output_text.delta` plus snapshot variants.
4. Pipeline post-processes suggestion (normalization, duplicate suppression, timeout fallback heuristics).
5. Non-empty suggestion is returned as inline ghost text; empty outcomes are logged with diagnostics.

See [context_repo_summary.md](context_repo_summary.md) for a file-level execution map.

## Testing quick commands (maintainer reference)

```bash
npm test
npm run bulk:test:cli -- --workspace . --skip-analyze
npm run response:test:cli -- --workspace .
```

CLI token resolution order: `--token`, `TAB_AUTOCOMPLETE_BEARER_TOKEN`, `test/artifacts/oauth_test_token.txt`, `test_files/oauth_test_token.txt`, then `OPENAI_API_KEY`.

