# Codex Autocomplete

All settings are under `codexAutocomplete`.

## Normal usage

These settings are intended for standard setup and baseline operation.

- `codexAutocomplete.enabled`
  - Type: `boolean`
  - Default: `true`
  - Controls whether inline AI completion is active at all.

- `codexAutocomplete.triggerMode`
  - Type: `string` (`automatic` | `hotkey`)
  - Default: `hotkey`
  - `automatic` requests suggestions while typing.
  - `hotkey` only requests suggestions when you trigger the hotkey command.

- `codexAutocomplete.endpoint`
  - Type: `string`
  - Default: `https://chatgpt.com/backend-api/codex/responses`
  - Endpoint used for completion requests.
  - Common values:
    - OAuth flow: `https://chatgpt.com/backend-api/codex/responses`
    - API key flow: `https://api.openai.com/v1/responses`

- `codexAutocomplete.endpointMode`
  - Type: `string` (`auto` | `oauth` | `apiKey` | `custom`)
  - Default: `auto`
  - `auto` chooses endpoint based on available auth type.
  - `custom` uses `codexAutocomplete.endpoint` exactly as provided.

- `codexAutocomplete.model`
  - Type: `string`
  - Default: `gpt-5.4`
  - Model ID used for completion requests.

- `codexAutocomplete.completionConstraintLines`
  - Type: `string[]`
  - Default: built-in inline completion rule list
  - The base rule lines attached to inline completion requests.
  - These lines are combined with language-specific and cursor-specific guidance at request time.
  - Use this when you want to tighten or relax the extension's default completion rules without changing the rest of the request pipeline.

## Completion behavior tuning

These settings tune completion style, responsiveness, and context shaping.

- `codexAutocomplete.debounceMs`
  - Type: `number` (min `0`)
  - Default: `60`
  - Delay before issuing completion requests after typing.
  - Lower values feel more responsive but can increase request volume.

- `codexAutocomplete.maxLatencyMs`
  - Type: `number` (min `50`)
  - Default: `1800`
  - Max total time to wait for a completion before cancellation.
  - Inline requests use an extended staged budget profile that can internally raise the effective total budget above this value; see [how_it_works.md](how_it_works.md).

- `codexAutocomplete.firstChunkMaxLatencyMs`
  - Type: `number` (min `50`)
  - Default: `1400`
  - Max wait time for first streamed output token/chunk.
  - Useful for controlling perceived responsiveness.
  - Inline requests use an extended staged budget profile that can internally raise the effective first-chunk budget above this value; see [how_it_works.md](how_it_works.md).

- `codexAutocomplete.rateLimitWindowSec`
  - Type: `number` (min `1`)
  - Default: `10`
  - Sliding window size for local request-rate limiting.

- `codexAutocomplete.rateLimitMaxRequests`
  - Type: `number` (min `1`)
  - Default: `5`
  - Max completion requests allowed per rate-limit window.

- `codexAutocomplete.maxOutputTokens`
  - Type: `number` (min `1`)
  - Default: `128`
  - Upper bound on generated completion length.
  - Lower values can reduce latency and over-completion risk.
  - Sent on `api.openai.com` Responses requests; the ChatGPT backend endpoint does not currently receive this field.

- `codexAutocomplete.maxContextLines`
  - Type: `number` (min `1`)
  - Default: `60`
  - Max lines before cursor included in prompt context.
  - Larger values may improve accuracy but increase latency/cost.

- `codexAutocomplete.maxFileLines`
  - Type: `number` (min `1`)
  - Default: `5000`
  - Files above this line count are skipped for completion.
  - Prevents expensive context building on very large files.

Maintainer-focused request-shaping defaults are documented inline in this file where relevant.
