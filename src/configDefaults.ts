import { DEFAULT_COMPLETION_CONSTRAINT_LINES } from './completion/completionInstructions';

export const WORKSPACE_SETTING_DEFAULTS = {
  enabled: true,
  triggerMode: 'hotkey' as const,
  endpoint: 'https://chatgpt.com/backend-api/codex/responses',
  endpointMode: 'auto' as const,
  model: 'gpt-5.4',
  completionConstraintLines: DEFAULT_COMPLETION_CONSTRAINT_LINES,
  debounceMs: 60,
  maxLatencyMs: 1800,
  firstChunkMaxLatencyMs: 1400,
  maxContextLines: 60,
  maxFileLines: 5000,
  rateLimitWindowSec: 10,
  rateLimitMaxRequests: 5,
  maxOutputTokens: 128,
  serviceTier: 'priority',
  promptCacheKey: 'codex-autocomplete:py:feature_workflow:v1',
  promptCacheRetention: '24h',
  logLevel: 'info' as const,
};

export const INLINE_PROVIDER_INTERNAL_DEFAULTS = {
  fastStageMaxLatencyMs: 500,
  fastStagePrefixLines: 32,
  fastStageSuffixLines: 16,
  hotkeySemanticRetryEnabled: true,
  hotkeySemanticRetryMaxLatencyMs: 1800,
  hotkeySemanticRetryFirstChunkMaxLatencyMs: 900,
};
