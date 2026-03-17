# Test Suite Architecture

This folder contains the `npm test` suite for the extension.

`npm test` is defined in [package.json](../package.json) as:

```bash
npm run compile && node --test test/**/*.test.js
```

At a high level, the architecture is:

1. TypeScript source in `src/` is compiled into `out/`.
2. Node's built-in test runner executes the `*.test.js` files in this folder.
3. Most tests import runtime code from `out/...`, not from `src/...`, so they validate the compiled artifact shape that the extension and CLI scripts actually run.

## Execution Layers

The suite is organized around a few broad layers.

### 1. Runtime Unit Tests

These validate isolated building blocks:

- context construction: `contextBuilder.test.js`, `contextEnrichment.test.js`
- request shaping and prompt metadata: `stageRequestFactory.test.js`, `promptCacheKey.test.js`
- suggestion repair and fallback behavior: `suggestionNormalizer.test.js`, `timeoutFallback.test.js`
- latency, throttling, and telemetry primitives: `latencyBudget.test.js`, `rateLimiter.test.js`, `inlineTelemetry.test.js`
- auth and token utilities: `oauth.test.js`, `oauthServer.test.js`, `pkce.test.js`, `tokenManager.test.js`
- logging and output helpers: `codexLogger.test.js`, `outputChannel.test.js`

### 2. Provider and Pipeline Tests

These test the core request/response path in progressively larger pieces:

- `codexProvider.test.js` checks SSE parsing, retry behavior, endpoint-specific payload differences, and compact prompt shaping.
- `completionPipeline.test.js` checks the two-stage fast/full completion flow, cache reuse, and stage telemetry.
- `phase5Completion.test.js` checks the `InlineCompletionProvider` end-to-end orchestration layer: debounce, cancellation, hotkey behavior, adaptive fast-stage skipping, timeout fallback, and normalization.

### 3. CLI and Runner Tests

These validate the terminal benchmarking flows without needing a live model:

- `bulkTestRunner.test.js` covers `runAutocompleteBulkTest`
- `responseTimeRunner.test.js` covers `runAutocompleteResponseTimeTest`
- `bulkAnalyzeScript.test.js`, `bulkWorkflowScript.test.js`, `responseTimeCliScript.test.js`, and `responseTimeHistoryCompareScript.test.js` cover the CLI wrappers and analysis scripts
- `extensionResponseTimeCommand.test.js` checks extension command wiring around the response-time path

These tests are the closest automated checks for the same runner logic used by:

- `npm run bulk:test:cli`
- `npm run response:test:cli`

### 4. VS Code Surface Tests

Some runtime modules depend on the VS Code API. Those tests run under plain Node by loading `helpers/registerVscode.js`, which intercepts `require('vscode')` and returns a stub implementation.

This keeps the suite fast and terminal-friendly while still exercising extension-facing code such as:

- inline completion provider flow
- trigger gating
- hotkey command behavior
- UI/controller glue

## Relationship To `test_files/`

This folder is different from `test_files/`.

- `test/` contains code-driven tests run by `npm test`.
- `test_files/` contains fixture source files and dataset inputs used by the bulk and response-time CLI benchmarks.

Most files in `test/` are not executed by `bulk:test:cli` or `response:test:cli`.
Those CLI workflows read dataset rows from `test_files/autocomplete_test_*` and `test_files/response_time_test_input.json`.
The main overlap is when a file under `test/` is referenced as an input fixture by a dataset row, such as `test/codexProvider.test.js`.

## Relationship To `bulk:test:critical`

`npm test` is the full automated suite.

`npm run bulk:test:critical` is narrower and release-oriented:

1. run a selected subset of high-signal Node tests
2. run the bulk CLI workflow
3. analyze bulk outputs
4. run response-time CLI benchmarking and compare recent history

So:

- `npm test` is the broad correctness suite
- `bulk:test:critical` is the compact regression gate around benchmark workflows
