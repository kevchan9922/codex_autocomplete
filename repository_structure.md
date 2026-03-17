# Repository Structure

This document explains the purpose of the main folders in the repository root.

## Root folders

- `.git/`
  - Git metadata for version control.

- `.vscode/`
  - Local VS Code workspace settings and launch/task configuration for contributors.

- `context/`
  - Project context/reference material used during development and iteration.

- `docs/`
  - Longer-form project documentation and supporting assets that do not fit in the root docs.

- `docs/images/`
  - Images and GIFs used by the README and other docs.

- `node_modules/`
  - Installed npm dependencies used for local development, testing, and packaging.

- `out/`
  - Compiled JavaScript output produced from the TypeScript source in `src/`.
  - Used by the extension runtime, CLI scripts, and tests after compilation.

- `scripts/`
  - Contributor-facing Node.js utilities for benchmarks, analysis, auth helpers, and local environment cleanup.
  - Includes bulk autocomplete workflows, response-time workflows, history comparison, and token/settings helpers.

- `src/`
  - Main extension source code.
  - Contains the VS Code extension entrypoint plus the runtime modules for auth, completion, debugging, logging, and performance tracking.

- `src/api/`
  - Provider-facing request/response integration, endpoint handling, and rate limiting.

- `src/auth/`
  - OAuth flow, PKCE handling, local auth callback server, and token storage helpers.

- `src/completion/`
  - Core inline completion pipeline: context building, staged requests, latency handling, post-processing, and trigger control.

- `src/debug/`
  - Debug-only workflows and runtime-aligned benchmark runners used by maintainers.

- `src/logging/`
  - Shared logging utilities for `[codex]` diagnostics.

- `src/performance/`
  - Metrics collection and performance instrumentation helpers.

- `test/`
  - Automated tests for extension runtime behavior, scripts, and utilities.

- `test/helpers/`
  - Test-only helpers and fixtures used across multiple test files.

- `test_artifacts/`
  - Generated benchmark output such as bulk CSVs and response-time history files.
  - This is a runtime/output area rather than a source folder.

- `test_files/`
  - Input datasets and example source files used by tests, bulk benchmarks, and response-time benchmarks.

- `test_files/<language>/`
  - Language-specific sample files used for autocomplete evaluation and regression coverage.

- `test_guide/`
  - Runbooks for maintainers running benchmark and validation workflows manually.

## Root-level docs and config

The repository root also contains the main contributor and product docs such as `README.md`, `features.md`, `commands.md`, `configuration.md`, and `development_workflow.md`, along with core project config like `package.json` and `tsconfig.json`.
