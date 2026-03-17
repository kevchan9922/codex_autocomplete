# Test Guide

This folder documents runtime-aligned benchmark workflows.

## Included runbooks

- `bulk_autocomplete_cli_runbook.md`
- `response_time_test_runbook.md`

## Important alignment rule

Both benchmark CLIs (`bulk:test:cli` and `response:test:cli`) use the same core context/request/provider modules as the extension runtime. If behavior changes in `src/completion/*` or `src/api/*`, update the runbooks and corresponding tests in `test/`.


## CI test command

Use `npm test` (which compiles first, then runs `node --test test`) for repository-level checks before running benchmark CLIs.
