# Test Files Architecture Overview

This folder holds the source fixtures and dataset inputs used by the terminal test workflows.
Run outputs are written to `test_artifacts/`.
For step-by-step run instructions, use the runbooks in `test_guide/`.

## Shared Building Blocks

Both `bulk_auto_complete_cli` and `response_time_test` follow the same top-level pattern:

1. A CLI script in `scripts/` parses flags, resolves auth, chooses endpoint/model, and builds an `AIProvider` with `src/api/providerFactory.ts`.
2. Context is extracted from fixture source files with `src/completion/contextBuilder.ts`. Rows can override file path, language, and cursor metadata.
3. A runner in `src/debug/` executes the dataset row-by-row and writes CSV artifacts into `test_artifacts/`.

## Adding New Tests

Use this checklist when adding a new benchmark row or fixture.

1. Pick the right dataset first.
   - `test_files/autocomplete_test_input.json`: main quality/regression coverage for `npm run bulk:test:cli`
   - `test_files/response_time_test_input.json`: smaller representative latency set for `npm run response:test:cli`
   - `test_files/autocomplete_test_followup_input.json`, `test_files/autocomplete_test_repeatability_input.json`, and the markdown-specific JSON files: focused subsets intended for targeted runs with `--input-file`
2. Add or update the source fixture under `test_files/<language>/` (or another existing subfolder such as `markdown/` or `plaintext/`).
   - Keep fixtures small, stable, and self-contained.
   - Prefer one clear completion scenario per insertion point.
   - Include enough nearby symbols/imports/helpers for the intended completion to be justified by local context.
3. Add a JSON row with explicit metadata. The accepted schema is:

```json
{
  "test": "TS-4 Example name | file=test_files/typescript/simple_autocomplete.ts | cursor after: const value = helper( | short expectation.",
  "target_output": "input);",
  "file_path": "test_files/typescript/simple_autocomplete.ts",
  "language_id": "typescript",
  "cursor_after": "const value = helper(",
  "lock_arg_form": true
}
```

4. Required fields:
   - `test`: stable human-readable name; keep the prefix short and searchable because `bulk:test:cli` supports `--test-pattern`
   - `target_output`: the exact text to insert at the cursor, not the whole line or file
5. Common optional fields:
   - `file_path`: relative path to the fixture file; set this explicitly for new rows
   - `language_id`: optional but recommended; otherwise the CLI infers it from the file extension
   - `cursor_after`: preferred cursor selector when the marker text is unique
   - `cursor_after_occurrence`: use when the same marker appears multiple times; occurrences are 1-based
   - `cursor_line` and `cursor_char`: use for blank-line, EOF, or ambiguous-marker cases; both are 1-based
   - Use either `cursor_after` or `cursor_line`/`cursor_char` for the row's primary cursor definition
6. Cursor resolution rules:
   - If `cursor_line` is set, the CLI uses it directly and does not resolve `cursor_after`.
   - If `cursor_char` is omitted, the cursor defaults to the end of the selected line.
   - If `cursor_after` is used, the cursor is placed immediately after the matched marker text.
   - Prefer `cursor_line`/`cursor_char` for blank lines because there may be no stable marker string to search for.
7. Lock flags are optional and should be used only when the exact form matters:
   - `lock_quotes`: preserve quote delimiters exactly
   - `lock_arg_form`: preserve positional vs named-argument structure
   - `lock_object_key_order`: preserve object literal key order
   - `lock_delimiter_spacing`: preserve spacing inside delimiter-sensitive string literals
8. `row_tags` is only supported by `response_time_test_input.json`.
   - Use it to force tags that should appear in latency history output.
   - The response-time runner also auto-infers tags such as `near_duplicate`, `large_file`, `chain`, and `lang:<id>`.
9. Use `<scenario-dependent>` for `target_output` only when exact-match scoring is intentionally not stable enough to be useful.
   - Bulk analysis marks those rows for manual review instead of strict exact-match grading.
   - Response-time history keeps the row but excludes it from exact-match scoring.
10. Prefer adding new coverage to `autocomplete_test_input.json` first, then copy only representative rows into `response_time_test_input.json`.
    - The bulk dataset should be broad and exact-match oriented.
    - The response-time dataset should stay smaller so latency history remains comparable over time.

## Quick Validation

After adding a row, run the narrowest command that exercises it:

```bash
npm run bulk:test:cli -- --workspace . --test-pattern "TS-4 Example name"
```

For a focused ad hoc dataset:

```bash
npm run bulk:test:cli -- --workspace . --input-file test_files/autocomplete_test_followup_input.json
```

For latency coverage:

```bash
npm run response:test:cli -- --workspace . --input-file test_files/response_time_test_input.json
```

If the row was added to the main bulk dataset, follow up with:

```bash
npm run bulk:test:analyze -- --mode strict
```

## `bulk_auto_complete_cli`

`bulk_auto_complete_cli` maps to `npm run bulk:test:cli`, which starts in `scripts/run-bulk-autocomplete-test.js`.

High-level flow:

1. The CLI reads `test_files/autocomplete_test_input.json` by default, or another JSON file passed with `--input-file`.
2. For each row, it resolves the source file and cursor position. Cursor placement can come from explicit line/char values or from a `cursor_after` marker in the source file.
3. The CLI builds a completion context JSON blob containing prefix, suffix, before-lines, and a context hash. With `--scope-mode function`, it first tries to narrow the prompt to the enclosing function/method before building the sliding window.
4. `src/debug/bulkTestRunner.ts` runs each row through one of two execution modes:
   - `direct`: one streamed completion request through the provider.
   - `hotkey_inline`: a two-stage `CompletionPipeline` request that tries a fast trimmed-context request first, then falls back to a full-context request if needed.
5. The runner normalizes the returned suggestion, applies timeout fallback text when appropriate, and checks whether the row should be retried.
6. Retry policy is quality-oriented, not latency-oriented. The runner can retry for:
   - empty output
   - numeric literal mismatch
   - semantic mismatch
7. On retries, it rebuilds the prompt with stricter token and formatting constraints derived from the row's `target_output` and optional lock flags such as quote, argument-form, object-key-order, and delimiter-spacing locks.
8. Final results are appended to `test_artifacts/autocomplete_test_output_YYYYMMDD_HHMMSS.csv` with `test,target_output,context,output`.

Supporting layers:

- `scripts/run-bulk-autocomplete-workflow.js` is a wrapper used by `npm run bulk:test:quick`. It runs the CLI, finds the latest CSV, optionally shows key columns, runs the analyzer, and checks input/output row-count parity.
- `scripts/analyze-bulk-autocomplete-output.js` is the scoring/gating layer used for strict and tolerant release checks.

## `response_time_test`

`response_time_test` maps to `npm run response:test:cli`, which starts in `scripts/run-response-time-test.js`.

High-level flow:

1. The CLI reads `test_files/response_time_test_input.json` by default, or another JSON file passed with `--input-file`.
2. For each row, it resolves the same kind of file/cursor metadata used by the bulk runner and builds a completion context from the source fixture.
3. `src/debug/responseTimeRunner.ts` initializes two artifacts:
   - a per-run CSV: `test_artifacts/response_time_test_output_YYYYMMDD_HHMMSS.csv`
   - an append-only history file: `test_artifacts/response_time_history.csv`
4. Each row is executed in one of two benchmark modes:
   - `automatic_direct`: one direct streamed provider request
   - `hotkey_inline`: the same `CompletionPipeline` hotkey path used by inline autocomplete, including fast-stage/full-stage fallback and optional semantic retry
5. The runner records first-chunk latency, total duration, status, target match, context size, instruction size, estimated input chars/tokens, output text, and benchmark mode.
6. Suggestions are normalized before being written, and timeout fallback text is used when the hotkey pipeline times out before returning a real suggestion.
7. After the run, the latest two comparable runs can be compared with `scripts/compare-response-time-history.js` (`npm run response:test:compare-last`). That script reads the history CSV, selects runs that contain comparable latency samples, reports when the latest overall run is skipped for lacking them, and summarizes latency regressions or improvements.

## Architectural Difference

- `bulk_auto_complete_cli` is primarily a quality/regression harness. Its key control loop is retry plus analysis against expected output.
- `response_time_test` is primarily a latency harness. Its key control loop is timing collection plus historical comparison across runs.
