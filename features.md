# Features

This document provides a more detailed view of the extension's core capabilities.

## User-facing functionality

These are the capabilities intended for day-to-day extension users inside VS Code.

### Inline completion experience

- Provides inline ghost-text suggestions directly in the editor.
- Lets developers accept suggestions with `Tab` as part of a fast editing loop.
- Returns full lines and completes partial lines of code, depending on what is already on the current line.
- Focuses on low-friction completion behavior that stays in the flow of normal coding.

### Triggering and invocation

- Supports configurable trigger modes under `codexAutocomplete.triggerMode`.
- By default explicit hotkey workflows (`Option+Tab` or `Ctrl+Option+Space`) for teams that prefer manual control.
- Includes automatic suggestion option triggering when typing pauses (setup in configuration).
- For manual Command Palette triggering, use `Codex Autocomplete: Debug Trigger Hotkey` (`codexAutocomplete.triggerHotkey`) or `Codex Autocomplete: Debug Trigger Suggestion` (`codexAutocomplete.trigger`).

### Authentication and access

- Uses OAuth-based login and logout flows.
- Stores tokens securely using VS Code `SecretStorage`.
- Avoids requiring direct API key handling in local developer environments.
- Command Palette entries:
  - `Codex Autocomplete: Login` (`codexAutocomplete.login`)
  - `Codex Autocomplete: Logout` (`codexAutocomplete.logout`)

### Context construction

- Builds completion context from a sliding window around the cursor.
- Uses file-size and line-limit safeguards to prevent overly large payloads.
- Prioritizes relevant local code context for practical completions.

### Pre-processing before requests

- Splits the current editor state into prefix, suffix, line prefix, and line suffix so the model can finish the current line cleanly.
- Builds a bounded local context window around the cursor instead of sending the whole file by default.
- Carries language, file path, cursor position, and selection state into the request pipeline so completions stay grounded in the active document.
- Hashes the request context so duplicate in-flight work can be detected and stale requests can be cancelled or ignored.

### Request reliability and safety

- Applies request rate limiting (default `5` requests per `10s`) to control burst behavior.
- Handles upstream `429` responses (too many requests) with bounded retries (max 2) and jittered backoff.
- Uses cancellation-first execution so stale requests are dropped as editor state changes.
- Performs in-flight deduplication to reduce unnecessary duplicate requests.

### Fast response-time optimization

- Keeps request payloads lean with sliding-window context and maximum context/file-line limits.
- Uses a staged request path: a fast nearby-context request runs first, then a full-context fallback runs when the fast stage returns empty or errors.
- Shapes inline latency with separate fast-stage, first-chunk, and total-budget limits so slow requests can be cut off without blocking the editor.
- Reduces avoidable requests with short debounce control and in-flight deduplication.
- Shares the same ghost-text post-processing and blank-result fallback heuristics across the inline provider and benchmark CLIs.
- Improves perceived speed with separate first-token and total-latency budgets:
  - `codexAutocomplete.firstChunkMaxLatencyMs` to cap wait for first streamed output.
  - `codexAutocomplete.maxLatencyMs` to cap overall request duration.
- Cancels stale work aggressively when typing or cursor state changes.
- Adds small timeout fallback heuristics to reduce blank ghost-text responses when the stream never produces usable text.

### Fast stage and retry behavior

- Fast-stage requests use a smaller nearby-context prompt first so explicit autocomplete can return quickly when the answer is local to the cursor.
- If that fast stage does not produce a usable suggestion, the pipeline falls back to a full-context request built from the broader editor context.
- Explicit hotkey requests have an additional protection path: when the fast stage times out before any first chunk arrives, the full-stage request can restart with a refunded budget instead of only using the leftover time.
- Hotkey requests also support a semantic retry path. After a non-empty result, the extension can issue one small follow-up retry when the first answer looks semantically suspicious.
- The semantic retry uses its own tighter latency budget, so it can repair questionable hotkey suggestions without turning every request into a long second pass.

### Post-processing after responses

- Normalizes returned text before it is shown as ghost text so formatting and insertion behavior stay consistent at the cursor.
- Repairs some incomplete or malformed suggestions using local prefix/suffix context when the raw model output is close but not directly usable.
- Applies timeout fallback heuristics when a request times out before producing a usable first chunk, reducing blank autocomplete results in narrow cases.
- Drops duplicate suggestions that would just repeat meaningful code already present later in the local suffix.

Maintainer-oriented debugging and validation details are consolidated in this document and the runbooks under `test_guide/`.

### Related docs

- [README.md](README.md) for project overview and high-level capabilities.
- [configuration.md](configuration.md) for settings details.
- [commands.md](commands.md) for command behavior and outputs.
- [troubleshooting.md](troubleshooting.md) for common issue resolution.
