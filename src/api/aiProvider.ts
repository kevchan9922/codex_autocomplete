export interface CompletionRequest {
  prefix: string;
  suffix: string;
  linePrefix?: string;
  lineSuffix?: string;
  selection?: string;
  languageId: string;
  filePath: string;
  model?: string;
  context?: string;
  instructions?: string;
  maxOutputTokens?: number;
  serviceTier?: string;
  promptCacheKey?: string;
  promptCacheRetention?: string;
  reasoningEffort?: 'none' | 'low';
  priority?: 'high' | 'normal';
  interactionMode?: 'automatic' | 'hotkey';
  onTelemetry?: (telemetry: CompletionRequestTelemetry) => void;
}

export interface CompletionChunk {
  text: string;
  done?: boolean;
  progress?: boolean;
}

export interface CompletionRequestTelemetry {
  preAttemptMs?: number;
  responseStatus?: number;
  headersLatencyMs?: number;
  firstRawChunkMs?: number;
  firstPayloadMs?: number;
  firstTextMs?: number;
  streamDurationMs?: number;
  serverProcessingMs?: number;
  requestId?: string;
}

export interface AIProvider {
  streamCompletion(
    request: CompletionRequest,
    signal: AbortSignal,
  ): AsyncIterable<CompletionChunk>;
}
