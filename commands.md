# Commands

Run commands from the VS Code Command Palette (`Cmd/Ctrl+Shift+P`).

## User-facing commands

- `Codex Autocomplete: Login`
  - Starts OAuth login and stores tokens in VS Code `SecretStorage`.
  - Typical success message: `Codex Autocomplete: logged in.`

- `Codex Autocomplete: Logout`
  - Clears stored auth tokens and disables authenticated completion calls.
  - Typical success message: `Codex Autocomplete: logged out.`

## Debug and validation commands

- `Codex Autocomplete: Debug Trigger Suggestion`
  - Marks a manual trigger window and forwards to `editor.action.inlineSuggest.trigger`.

- `Codex Autocomplete: Debug Trigger Hotkey`
  - Forces the explicit hotkey request path and immediately triggers inline suggestion rendering.

- `Codex Autocomplete: Debug Token Check`
  - Confirms whether an access token is currently available.

- `Codex Autocomplete: Debug Context`
  - Emits a runtime-aligned request/context report to the extension output channel.

- `Codex Autocomplete: Debug Metrics`
  - Emits inline completion counters and latency snapshots.

- `Codex Autocomplete: Debug response time test`
  - Runs the response-time benchmark workflow and writes CSV artifacts under `test_artifacts/`.
