# Repository Summary (public-release aligned)

## Primary execution path: hotkey -> ghost text

1. **Command registration + hotkey trigger wiring**
   - `src/extension.ts`
   - Registers `codexAutocomplete.triggerHotkey`, marks the manual trigger window, then forwards to `editor.action.inlineSuggest.trigger`.

2. **Inline request orchestration**
   - `src/completion/inlineProvider.ts`
   - Applies trigger gating, context build, cancellation/debounce, stage-request build, pipeline execution, post-processing, and ghost-text item rendering.

3. **Fast/full request construction**
   - `src/completion/stageRequestFactory.ts`
   - Builds fast request (`context: undefined`) and lazy full request (with enriched context).
   - Both reuse `buildInlineRequestInstructions` from `src/completion/completionInstructions.ts`.

4. **Provider call + SSE parsing**
   - `src/api/codexProvider.ts`
   - Builds Responses API body, rate-limits/retries, streams SSE, reconstructs text deltas, and logs full request/response payloads at debug level with redaction.

5. **Suggestion quality controls**
   - `src/completion/completionPipeline.ts`
   - Fast->full fallback, hotkey semantic retry, timeout shaping, and stage telemetry.
   - `src/completion/ghostTextPostProcessor.ts`
   - Duplicate suppression, suffix safety, timeout fallback, and normalization.

6. **UI + acceptance logging**
   - `src/completion/inlineUiController.ts` + `src/extension.ts`
   - Timeout/empty notifications and suggestion-accept telemetry logging.

## Benchmark/CLI alignment

- `scripts/run-bulk-autocomplete-test.js`
- `scripts/run-response-time-test.js`

Both CLIs call runtime modules (`buildCompletionContext`, `buildStageRequests`, provider factory, and post-processing/hotkey flow runners) so benchmark behavior matches hotkey-to-ghost-text execution.

## Logging/debug safety

- `src/logging/codexLogger.ts`
  - level filtering
  - sink support
  - token/header redaction
  - payload chunking for large full-body logs

## Test layout

- `test/*.test.js` — unit/integration tests run by `npm test`.
- `test_guide/` — benchmark/validation runbooks.
- `test_files/` — benchmark corpora and scenario inputs.


## Release-safety notes

- `package.json` defaults are kept aligned with runtime constants (`src/configDefaults.ts` and `src/completion/completionInstructions.ts`) to avoid drift between extension behavior and published settings.
- `npm test` runs through `node --test test` so the repository test suite is actually discovered in Node 20+ without shell-glob issues.
