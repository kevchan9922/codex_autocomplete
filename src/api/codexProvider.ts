import { TokenManager } from '../auth/tokenManager';
import { RateLimiter } from './rateLimiter';
import {
  AIProvider,
  CompletionChunk,
  CompletionRequest,
  CompletionRequestTelemetry,
} from './aiProvider';
import { codexDebug, codexLog, codexLogPayload } from '../logging/codexLogger';

interface HttpStreamRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}

interface HttpStreamResponse {
  status: number;
  ok: boolean;
  stream: AsyncIterable<string>;
  headers?: Record<string, string>;
  preAttemptMs?: number;
  requestLatencyMs?: number;
}

export interface PromptContextPayload {
  schema_version: 'inline_context_v1';
  file_path?: string;
  selection?: string;
  language: string;
  context_priority?: {
    primary_order: string;
  };
  cursor_context: {
    line_prefix: string;
    line_suffix: string;
    indent: string;
    token_before_cursor: string | null;
    call_context: string | null;
  };
  priority_context?: {
    current: string;
    prev: string | null;
    next: string | null;
  };
  scope_context?: {
    strategy: 'python_scope' | 'brace_scope';
    header: string;
  };
  extra_context?: string;
  ordered_context?: RankedContextLine[];
  task?: string;
}

export interface RankedContextLine extends RankedLine {
  side: 'prefix' | 'suffix';
}

export interface HttpStreamClient {
  request(request: HttpStreamRequest): Promise<HttpStreamResponse>;
}

export interface CodexProviderOptions {
  endpoint: string;
  model: string;
  instructions?: string;
  tokenManager: Pick<TokenManager, 'getAccessToken'>;
  httpClient?: HttpStreamClient;
  rateLimiter?: RateLimiter;
  maxRetries?: number;
  automaticModeMaxRetries?: number;
  baseRetryDelayMs?: number;
  maxOutputTokens?: number;
  serviceTier?: string;
  promptCacheKey?: string;
  promptCacheRetention?: string;
}

export interface BuildCodexRequestBodyOptions {
  endpoint: string;
  model: string;
  instructions?: string;
  maxOutputTokens?: number;
  serviceTier?: string;
  promptCacheKey?: string;
  promptCacheRetention?: string;
}

export class CodexProvider implements AIProvider {
  private readonly endpoint: string;
  private readonly model: string;
  private readonly instructions?: string;
  private readonly tokenManager: Pick<TokenManager, 'getAccessToken'>;
  private readonly httpClient: HttpStreamClient;
  private readonly rateLimiter: RateLimiter;
  private readonly maxRetries: number;
  private readonly automaticModeMaxRetries: number;
  private readonly baseRetryDelayMs: number;
  private readonly maxOutputTokens?: number;
  private readonly serviceTier?: string;
  private readonly promptCacheKey?: string;
  private readonly promptCacheRetention?: string;

  constructor(options: CodexProviderOptions) {
    this.endpoint = options.endpoint;
    this.model = options.model;
    this.instructions = options.instructions;
    this.tokenManager = options.tokenManager;
    this.httpClient = options.httpClient ?? new FetchHttpStreamClient();
    this.rateLimiter = options.rateLimiter ?? new RateLimiter();
    this.maxRetries = options.maxRetries ?? 2;
    this.automaticModeMaxRetries = options.automaticModeMaxRetries ?? 1;
    this.baseRetryDelayMs = options.baseRetryDelayMs ?? 200;
    this.maxOutputTokens = options.maxOutputTokens;
    this.serviceTier = options.serviceTier;
    this.promptCacheKey = options.promptCacheKey;
    this.promptCacheRetention = options.promptCacheRetention;
  }

  async *streamCompletion(
    request: CompletionRequest,
    signal: AbortSignal,
  ): AsyncIterable<CompletionChunk> {
    const startTime = Date.now();
    codexLog('[codex] request start');
    let loggedFirstChunk = false;
    const outputPreviewLimit = 400;
    let outputPreview = '';
    let fullResponseText = '';
    const appendOutputPreview = (text: string): void => {
      if (!text || outputPreview.length >= outputPreviewLimit) {
        return;
      }
      const remaining = outputPreviewLimit - outputPreview.length;
      outputPreview += text.slice(0, remaining);
    };
    const isAutomaticMode = request.interactionMode === 'automatic';
    const body = buildCodexRequestBody(request, {
      endpoint: this.endpoint,
      model: this.model,
      instructions: this.instructions,
      maxOutputTokens: this.maxOutputTokens,
      serviceTier: this.serviceTier,
      promptCacheKey: this.promptCacheKey,
      promptCacheRetention: this.promptCacheRetention,
    });

    const response = await this.requestWithRetry(
      body,
      signal,
      request.priority ?? 'normal',
      isAutomaticMode ? this.automaticModeMaxRetries : this.maxRetries,
      startTime,
    );
    const telemetryBase: CompletionRequestTelemetry = {
      preAttemptMs: response.preAttemptMs,
      responseStatus: response.status,
      headersLatencyMs: response.requestLatencyMs,
      serverProcessingMs: parseProviderProcessingMs(response.headers),
      requestId: extractRequestId(response.headers),
    };
    const streamDiagnostics = createSseStreamDiagnostics();
    const eventTypeCounts = new Map<string, number>();
    let parsedPayloadCount = 0;
    let nonJsonPayloadCount = 0;
    let emittedTextChunkCount = 0;
    let emittedDoneCount = 0;
    let ignoredTypedEventCount = 0;
    let firstParsedPayloadShape: string | undefined;
    let firstTypedPayloadShape: string | undefined;
    let ignoredTypedEventSample: string | undefined;
    let firstOutputItemMs: number | undefined;
    let firstExtractedTextMs: number | undefined;
    let lastSnapshotText = '';
    let streamSummaryLogged = false;
    const emitTelemetry = (): void => {
      request.onTelemetry?.({
        ...telemetryBase,
        firstRawChunkMs: streamDiagnostics.firstRawChunkLatencyMs,
        firstPayloadMs: streamDiagnostics.firstPayloadLatencyMs,
        firstTextMs: firstExtractedTextMs,
        streamDurationMs: Date.now() - streamDiagnostics.startedAtMs,
      });
    };
    const logStreamSummary = (reason: string): void => {
      if (streamSummaryLogged) {
        return;
      }
      streamSummaryLogged = true;

      codexDebug(
        `[codex] stream summary reason=${reason} rawChunks=${streamDiagnostics.rawChunkCount} rawChars=${streamDiagnostics.rawCharCount} sseEvents=${streamDiagnostics.sseEventCount} payloads=${streamDiagnostics.payloadCount} parsedPayloads=${parsedPayloadCount} nonJsonPayloads=${nonJsonPayloadCount} textChunks=${emittedTextChunkCount} doneSignals=${emittedDoneCount} firstRawChunkMs=${formatOptionalLatency(streamDiagnostics.firstRawChunkLatencyMs)} firstPayloadMs=${formatOptionalLatency(streamDiagnostics.firstPayloadLatencyMs)} firstOutputItemMs=${formatOptionalLatency(firstOutputItemMs)} firstTextMs=${formatOptionalLatency(firstExtractedTextMs)} ignoredTypedEvents=${ignoredTypedEventCount} trailingBufferChars=${streamDiagnostics.trailingBufferLength}`,
      );

      if (streamDiagnostics.rawPreview) {
        logResponseText(streamDiagnostics.rawPreview, '[codex] stream raw preview');
      }

      if (eventTypeCounts.size > 0) {
        codexDebug(`[codex] stream event types ${formatEventTypeCounts(eventTypeCounts)}`);
      } else if (parsedPayloadCount > 0) {
        codexDebug('[codex] stream event types <none>');
      }

      if (parsedPayloadCount > 0 && emittedTextChunkCount === 0) {
        codexDebug('[codex] stream warning: parsed payloads present but no text chunks emitted');
        if (firstParsedPayloadShape) {
          codexDebug(`[codex] stream first parsed payload shape ${firstParsedPayloadShape}`);
        }
        if (firstTypedPayloadShape) {
          codexDebug(`[codex] stream first typed payload shape ${firstTypedPayloadShape}`);
        }
        if (ignoredTypedEventSample) {
          codexDebug(`[codex] stream ignored typed event sample ${ignoredTypedEventSample}`);
        }
      }
    };

    try {
      for await (const payload of parseServerSentEvents(response.stream, signal, streamDiagnostics)) {
        if (payload === '[DONE]') {
          emittedDoneCount += 1;
          logStreamSummary('done_sentinel');
          emitTelemetry();
          codexDebug(`[codex] output preview ${JSON.stringify(outputPreview)}`);
          codexLogPayload('[codex] response body', fullResponseText || '<empty>', 'debug');
          codexLogPayload('[codex] response sse', streamDiagnostics.rawFullText || '<empty>', 'debug');
          codexLog(`[codex] request done in ${Date.now() - startTime}ms`);
          yield { text: '', done: true };
          return;
        }

        const parsed = tryParseEventPayload(payload);
        if (!parsed) {
          nonJsonPayloadCount += 1;
          if (nonJsonPayloadCount <= 3) {
            codexLog(
              `[codex] non-json SSE payload sample ${JSON.stringify(truncateChars(payload, 160))}`,
            );
          }
          continue;
        }
        parsedPayloadCount += 1;
        const payloadShape = JSON.stringify(describePayloadShape(parsed));
        if (!firstParsedPayloadShape) {
          firstParsedPayloadShape = payloadShape;
        }

        if (parsed.type) {
          if (!firstTypedPayloadShape) {
            firstTypedPayloadShape = payloadShape;
          }
          incrementEventTypeCount(eventTypeCounts, parsed.type);
          if (parsed.type === 'response.output_item.added' && firstOutputItemMs === undefined) {
            firstOutputItemMs = Date.now() - streamDiagnostics.startedAtMs;
          }
          if (parsed.type === 'response.output_text.delta') {
            const deltaText = extractTextFromOutputText(parsed.delta) ?? '';
            if (deltaText) {
              if (!loggedFirstChunk) {
                codexLog('[codex] first chunk received');
                loggedFirstChunk = true;
              }
              if (firstExtractedTextMs === undefined) {
                firstExtractedTextMs = Date.now() - streamDiagnostics.startedAtMs;
              }
              appendOutputPreview(deltaText);
              fullResponseText += deltaText;
              emittedTextChunkCount += 1;
              yield { text: deltaText, done: false };
            } else {
              yield { text: '', done: false, progress: true };
            }
            continue;
          }
        }

        const rawChunkText = extractTextChunk(parsed);
        const chunkText = computeSnapshotDelta(
          rawChunkText,
          fullResponseText || lastSnapshotText,
        );
        if (rawChunkText) {
          lastSnapshotText = rawChunkText;
        }
        const done = parsed.done === true || isTypedDoneEvent(parsed.type);

        if (chunkText || done) {
          if (chunkText && !loggedFirstChunk) {
            codexLog('[codex] first chunk received');
            loggedFirstChunk = true;
          }
          if (chunkText && firstExtractedTextMs === undefined) {
            firstExtractedTextMs = Date.now() - streamDiagnostics.startedAtMs;
          }
          appendOutputPreview(chunkText);
          if (chunkText) {
            fullResponseText += chunkText;
            emittedTextChunkCount += 1;
          }
          if (done) {
            emittedDoneCount += 1;
            logStreamSummary(parsed.type ?? 'done_flag');
            emitTelemetry();
            codexDebug(`[codex] output preview ${JSON.stringify(outputPreview)}`);
            codexLogPayload('[codex] response body', fullResponseText || '<empty>', 'debug');
            codexLogPayload('[codex] response sse', streamDiagnostics.rawFullText || '<empty>', 'debug');
            codexLog(`[codex] request done in ${Date.now() - startTime}ms`);
            yield { text: chunkText, done: true };
            return;
          }
          yield { text: chunkText, done: false };
          continue;
        }

        if (shouldEmitProgressEvent(parsed)) {
          yield { text: '', done: false, progress: true };
          continue;
        }

        if (parsed.type) {
          ignoredTypedEventCount += 1;
          if (!ignoredTypedEventSample) {
            ignoredTypedEventSample = JSON.stringify(describePayloadShape(parsed));
          }
        }
      }

      logStreamSummary('stream_end');
      emitTelemetry();
      codexDebug(
        `[codex] output preview (stream end) ${JSON.stringify(outputPreview)}`,
      );
      codexLogPayload('[codex] response body', fullResponseText || '<empty>', 'debug');
      codexLogPayload('[codex] response sse', streamDiagnostics.rawFullText || '<empty>', 'debug');
      codexLog(`[codex] request done in ${Date.now() - startTime}ms`);
    } catch (error) {
      logStreamSummary(signal.aborted ? 'cancelled' : 'error');
      emitTelemetry();
      logResponseText(outputPreview);
      if (signal.aborted) {
        codexDebug(
          `[codex] output preview (cancelled) ${JSON.stringify(outputPreview)}`,
        );
        codexLogPayload('[codex] response body', fullResponseText || '<empty>', 'debug');
        codexLogPayload('[codex] response sse', streamDiagnostics.rawFullText || '<empty>', 'debug');
        codexLog(`[codex] request cancelled after ${Date.now() - startTime}ms`);
      } else {
        codexDebug(
          `[codex] output preview (error) ${JSON.stringify(outputPreview)}`,
        );
        codexLogPayload('[codex] response body', fullResponseText || '<empty>', 'debug');
        codexLogPayload('[codex] response sse', streamDiagnostics.rawFullText || '<empty>', 'debug');
        codexLog('[codex] request error');
      }
      throw error;
    }
  }

  private async requestWithRetry(
    body: string,
    signal: AbortSignal,
    priority: 'high' | 'normal',
    maxRetries: number,
    overallStartedAt: number,
  ): Promise<HttpStreamResponse> {
    let lastStatus = -1;
    let firstAttemptStartedAt: number | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      throwIfAborted(signal);
      await this.rateLimiter.acquire({ signal, priority });
      const attemptStartedAt = Date.now();
      if (firstAttemptStartedAt === undefined) {
        firstAttemptStartedAt = attemptStartedAt;
      }
      codexLog(`[codex] attempt ${attempt + 1}`);
      const accessToken = await this.tokenManager.getAccessToken();
      const requestStartedAt = Date.now();

      codexLog(`[codex] endpoint ${this.endpoint}`);
      codexLogPayload('[codex] request body', body, 'debug');

      const response = await this.httpClient.request({
        url: this.endpoint,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body,
        signal,
      });
      const responseLatencyMs = Date.now() - requestStartedAt;
      codexLog(`[codex] response status ${response.status}`);
      codexLog(`[codex] response latency ${responseLatencyMs}ms`);
      logResponseHeaders(response.headers);

      if (response.ok) {
        return {
          ...response,
          preAttemptMs: Math.max(0, (firstAttemptStartedAt ?? requestStartedAt) - overallStartedAt),
          requestLatencyMs: responseLatencyMs,
        };
      }

      try {
        let responseText = '';
        for await (const chunk of response.stream) {
          responseText += chunk;
          if (responseText.length > 2000) {
            break;
          }
        }
        codexLog(`[codex] error response body ${responseText}`);
      } catch {
        codexLog('[codex] error response body unavailable');
      }

      if (response.status === 401 || response.status === 403) {
        codexLog(`[codex] request unauthorized: ${response.status}`);
        throw new Error('Codex request unauthorized. Check endpoint and login again.');
      }

      lastStatus = response.status;
      const shouldRetry = response.status === 429 && attempt < maxRetries;
      if (!shouldRetry) {
        codexLog(`[codex] request failed: ${response.status}`);
        throw new Error(`Codex request failed with status ${response.status}`);
      }

      const retryDelayMs = this.getRetryDelayMs(attempt);
      codexLog(`[codex] retrying in ${retryDelayMs}ms (status 429)`);
      await delayWithAbort(retryDelayMs, signal);
    }

    throw new Error(`Codex request failed with status ${lastStatus}`);
  }

  private getRetryDelayMs(attempt: number): number {
    const exponential = this.baseRetryDelayMs * 2 ** attempt;
    const jitter = Math.floor(Math.random() * this.baseRetryDelayMs);
    return exponential + jitter;
  }
}

class FetchHttpStreamClient implements HttpStreamClient {
  async request(request: HttpStreamRequest): Promise<HttpStreamResponse> {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: request.signal,
    });

    if (!response.body) {
      throw new Error('Codex response body was empty.');
    }

    return {
      status: response.status,
      ok: response.ok,
      stream: readUtf8Stream(response.body, request.signal),
      headers: extractRelevantResponseHeaders(response.headers),
    };
  }
}

async function* readUtf8Stream(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncIterable<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      yield decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

async function* parseServerSentEvents(
  stream: AsyncIterable<string>,
  signal: AbortSignal,
  diagnostics: SseStreamDiagnostics,
): AsyncIterable<string> {
  let buffer = '';
  let yielded = false;

  try {
    for await (const textChunk of stream) {
      throwIfAborted(signal);
      diagnostics.rawChunkCount += 1;
      diagnostics.rawCharCount += textChunk.length;
      diagnostics.rawFullText += textChunk;
      if (diagnostics.firstRawChunkLatencyMs === undefined) {
        diagnostics.firstRawChunkLatencyMs = Date.now() - diagnostics.startedAtMs;
      }
      appendStreamPreview(diagnostics, textChunk);
      buffer += textChunk.replace(/\r\n/g, '\n');

      let delimiterIndex = buffer.indexOf('\n\n');
      while (delimiterIndex >= 0) {
        diagnostics.sseEventCount += 1;
        const event = buffer.slice(0, delimiterIndex);
        buffer = buffer.slice(delimiterIndex + 2);

        const lines = event
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.startsWith('data:'));

        for (const line of lines) {
          const payload = line.slice('data:'.length).trim();
          if (payload) {
            yielded = true;
            diagnostics.payloadCount += 1;
            if (diagnostics.firstPayloadLatencyMs === undefined) {
              diagnostics.firstPayloadLatencyMs = Date.now() - diagnostics.startedAtMs;
            }
            yield payload;
          }
        }

        delimiterIndex = buffer.indexOf('\n\n');
      }
    }

    const trailing = buffer.trim();
    if (trailing.startsWith('data:')) {
      const payload = trailing.slice('data:'.length).trim();
      if (payload) {
        yielded = true;
        diagnostics.payloadCount += 1;
        if (diagnostics.firstPayloadLatencyMs === undefined) {
          diagnostics.firstPayloadLatencyMs = Date.now() - diagnostics.startedAtMs;
        }
        yield payload;
      }
    }
  } finally {
    diagnostics.trailingBufferLength = buffer.length;
  }

  if (!yielded) {
    codexLog(
      `[codex] stream ended without events rawChunks=${diagnostics.rawChunkCount} rawChars=${diagnostics.rawCharCount}`,
    );
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error('Request cancelled');
  }
}

interface ParsedEventPayload {
  type?: string;
  delta?: unknown;
  done?: boolean;
  text?: unknown;
  response?: unknown;
  item?: unknown;
  part?: unknown;
  content_part?: unknown;
  output_text?: unknown;
  content?: unknown;
  [key: string]: unknown;
}

function tryParseEventPayload(payload: string): ParsedEventPayload | undefined {
  try {
    return JSON.parse(payload) as ParsedEventPayload;
  } catch {
    return undefined;
  }
}

function extractTextChunk(payload: ParsedEventPayload): string {
  return (
    extractTextFromOutputText(payload.delta)
    ?? extractTextFromOutputText(payload.text)
    ?? extractTextFromResponseSnapshot(payload.response)
    ?? extractTextFromOutputItem(payload.item)
    ?? extractTextFromPart(payload.part)
    ?? extractTextFromPart(payload.content_part)
    ?? extractTextFromOutputText(payload.output_text)
    ?? extractTextFromOutputText(payload.content)
    ?? ''
  );
}

function extractTextFromResponseSnapshot(value: unknown): string | undefined {
  const response = asRecord(value);
  if (!response) {
    return undefined;
  }

  const output = response.output;
  if (!Array.isArray(output) || output.length === 0) {
    return undefined;
  }

  let combined = '';
  for (const item of output) {
    combined += extractTextFromOutputItem(item) ?? '';
  }
  return combined || undefined;
}

function extractTextFromOutputItem(value: unknown): string | undefined {
  const item = asRecord(value);
  if (!item) {
    return undefined;
  }

  const directText = extractTextFromOutputText(item.text)
    ?? extractTextFromOutputText(item.output_text)
    ?? extractTextFromOutputText(item.value);
  if (directText) {
    return directText;
  }

  const content = item.content;
  if (!Array.isArray(content) || content.length === 0) {
    return undefined;
  }

  let combined = '';
  for (const part of content) {
    combined += extractTextFromPart(part) ?? '';
  }
  return combined || undefined;
}

function extractTextFromPart(value: unknown): string | undefined {
  const part = asRecord(value);
  if (!part) {
    return undefined;
  }

  const direct = extractTextFromOutputText(part.delta)
    ?? extractTextFromOutputText(part.text)
    ?? extractTextFromOutputText(part.output_text)
    ?? extractTextFromOutputText(part.value);
  if (direct) {
    return direct;
  }

  const nestedContent = part.content;
  if (!Array.isArray(nestedContent) || nestedContent.length === 0) {
    return undefined;
  }
  let combined = '';
  for (const nestedPart of nestedContent) {
    combined += extractTextFromPart(nestedPart) ?? '';
  }
  if (combined) {
    return combined;
  }
  return extractTextFromOutputText(part.parts)
    ?? extractTextFromOutputText(part.items)
    ?? undefined;
}

function extractTextFromOutputText(value: unknown, depth = 0): string | undefined {
  if (depth > 6 || value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === 'string') {
    return value.length > 0 ? value : undefined;
  }

  if (Array.isArray(value)) {
    let combined = '';
    for (const entry of value) {
      combined += extractTextFromOutputText(entry, depth + 1) ?? '';
    }
    return combined || undefined;
  }

  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const direct = asNonEmptyString(record.text)
    ?? asNonEmptyString(record.value)
    ?? asNonEmptyString(record.delta);
  if (direct) {
    return direct;
  }

  const nestedCandidates = [
    record.output_text,
    record.text,
    record.value,
    record.delta,
    record.content,
    record.part,
    record.content_part,
    record.parts,
    record.items,
    record.segments,
    record.tokens,
  ];
  for (const candidate of nestedCandidates) {
    const extracted = extractTextFromOutputText(candidate, depth + 1);
    if (extracted) {
      return extracted;
    }
  }

  return undefined;
}

function computeSnapshotDelta(nextText: string, previousText: string): string {
  if (!nextText) {
    return '';
  }
  if (!previousText) {
    return nextText;
  }
  if (nextText === previousText) {
    return '';
  }
  if (nextText.startsWith(previousText)) {
    return nextText.slice(previousText.length);
  }
  // Snapshot format can shift between events; emit full replacement once.
  return nextText;
}

function isTypedDoneEvent(eventType: string | undefined): boolean {
  return eventType === 'response.output_text.done'
    || eventType === 'response.completed'
    || eventType === 'response.failed'
    || eventType === 'response.canceled';
}

function shouldEmitProgressEvent(payload: ParsedEventPayload): boolean {
  return payload.type === 'response.in_progress'
    || payload.type === 'response.output_item.added'
    || payload.type === 'response.content_part.added';
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
}

function describePayloadShape(payload: ParsedEventPayload): Record<string, unknown> {
  const shape: Record<string, unknown> = {
    type: payload.type ?? '<none>',
    keys: Object.keys(payload).slice(0, 12),
  };

  const item = asRecord(payload.item);
  if (item) {
    const itemShape: Record<string, unknown> = {
      keys: Object.keys(item).slice(0, 12),
    };
    if (Array.isArray(item.content)) {
      itemShape.contentParts = item.content.length;
      const firstPart = asRecord(item.content[0]);
      if (firstPart) {
        itemShape.firstContentPartKeys = Object.keys(firstPart).slice(0, 10);
      }
    }
    shape.item = itemShape;
  }

  const part = asRecord(payload.part) ?? asRecord(payload.content_part);
  if (part) {
    shape.part = {
      keys: Object.keys(part).slice(0, 12),
    };
  }

  return shape;
}

function logResponseText(value: string, label = '[codex] response text'): void {
  if (!value) {
    codexDebug(`${label} <empty>`);
    return;
  }

  const maxChars = 400;
  const clipped = value.length > maxChars ? value.slice(0, maxChars) : value;
  const suffix = value.length > maxChars ? '… (truncated)' : '';
  codexDebug(`${label} ${JSON.stringify(clipped)}${suffix}`);
}

function logResponseHeaders(headers: Record<string, string> | undefined): void {
  if (!headers || Object.keys(headers).length === 0) {
    codexDebug('[codex] response headers <none>');
    return;
  }
  codexDebug(`[codex] response headers ${JSON.stringify(headers)}`);
}

interface SseStreamDiagnostics {
  startedAtMs: number;
  rawChunkCount: number;
  rawCharCount: number;
  sseEventCount: number;
  payloadCount: number;
  firstRawChunkLatencyMs?: number;
  firstPayloadLatencyMs?: number;
  trailingBufferLength: number;
  rawPreview: string;
  rawFullText: string;
}

function createSseStreamDiagnostics(): SseStreamDiagnostics {
  return {
    startedAtMs: Date.now(),
    rawChunkCount: 0,
    rawCharCount: 0,
    sseEventCount: 0,
    payloadCount: 0,
    trailingBufferLength: 0,
    rawPreview: '',
    rawFullText: '',
  };
}

function appendStreamPreview(diagnostics: SseStreamDiagnostics, chunk: string): void {
  const maxPreviewChars = 400;
  if (diagnostics.rawPreview.length >= maxPreviewChars || !chunk) {
    return;
  }
  const remainingChars = maxPreviewChars - diagnostics.rawPreview.length;
  diagnostics.rawPreview += chunk.slice(0, remainingChars);
}

function incrementEventTypeCount(counts: Map<string, number>, eventType: string): void {
  const nextCount = (counts.get(eventType) ?? 0) + 1;
  counts.set(eventType, nextCount);
}

function formatEventTypeCounts(counts: Map<string, number>): string {
  const summaryObject = Object.fromEntries(
    Array.from(counts.entries())
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 12),
  );
  return JSON.stringify(summaryObject);
}

function formatOptionalLatency(value: number | undefined): string {
  return value === undefined ? '<none>' : `${value}`;
}

function extractRelevantResponseHeaders(headers: Headers): Record<string, string> {
  const keys = [
    'content-type',
    'cache-control',
    'transfer-encoding',
    'x-request-id',
    'x-openai-request-id',
    'openai-request-id',
    'x-openai-processing-ms',
    'openai-processing-ms',
    'server',
    'date',
  ];
  const result: Record<string, string> = {};
  for (const key of keys) {
    const value = headers.get(key);
    if (value) {
      result[key] = value;
    }
  }
  return result;
}

function extractRequestId(headers: Record<string, string> | undefined): string | undefined {
  if (!headers) {
    return undefined;
  }
  return headers['x-request-id']
    ?? headers['x-openai-request-id']
    ?? headers['openai-request-id'];
}

function parseProviderProcessingMs(headers: Record<string, string> | undefined): number | undefined {
  if (!headers) {
    return undefined;
  }
  const rawValue = headers['x-openai-processing-ms'] ?? headers['openai-processing-ms'];
  if (!rawValue) {
    return undefined;
  }
  const parsed = Number.parseFloat(rawValue);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function buildInlineContextPayload(
  request: CompletionRequest,
  options: { apiOptimized: boolean },
): PromptContextPayload {
  // Keep one compact payload profile across endpoints and interaction modes.
  const prefixWindowLines = 48;
  const suffixWindowLines = 20;
  const fullPrefixLines = splitContextLines(request.prefix);
  const fullSuffixLines = splitContextLines(request.suffix);
  const compactPrefixLines = takeLastArrayLines(fullPrefixLines, prefixWindowLines);
  const compactSuffixLines = takeFirstArrayLines(fullSuffixLines, suffixWindowLines);
  const focusedContext = focusContextLines(
    fullPrefixLines,
    fullSuffixLines,
    request.languageId,
  );
  const derivedLinePrefix = compactPrefixLines[compactPrefixLines.length - 1] ?? '';
  const derivedLineSuffix = compactSuffixLines[0] ?? '';
  const linePrefix = request.linePrefix ?? derivedLinePrefix;
  const lineSuffix = request.lineSuffix ?? derivedLineSuffix;
  const rankedPrefix = rankPrefixLines(compactPrefixLines);
  const rankedSuffix = rankSuffixLines(compactSuffixLines);
  const priorityContext = buildPriorityContext({
    prefixLines: compactPrefixLines,
    suffixLines: compactSuffixLines,
    linePrefix,
    lineSuffix,
  });
  const orderedContext = buildOrderedContext({
    prefix: rankedPrefix,
    suffix: rankedSuffix,
    linePrefix,
  });
  const indent = (linePrefix.match(/^\s*/) ?? [''])[0];
  const tokenBeforeCursor = getTokenBeforeCursor(linePrefix);
  const callContext = getCallContext(linePrefix);
  const scopeContext = buildScopeContext(focusedContext);
  const task = classifyInlineTask({
    languageId: request.languageId,
    linePrefix,
  });

  const payload: PromptContextPayload = {
    schema_version: 'inline_context_v1',
    file_path: request.filePath,
    language: request.languageId,
    context_priority: {
      primary_order: 'current > prev > next > others',
    },
    cursor_context: {
      line_prefix: linePrefix,
      line_suffix: lineSuffix,
      indent,
      token_before_cursor: tokenBeforeCursor ?? null,
      call_context: callContext ?? null,
    },
    priority_context: priorityContext,
    ...(scopeContext ? { scope_context: scopeContext } : {}),
    ordered_context: orderedContext,
    ...(task ? { task } : {}),
  };

  if (request.selection && request.selection.length > 0) {
    payload.selection = request.selection;
  }

  if (request.context) {
    payload.extra_context = truncateChars(
      request.context,
      800,
    );
  }

  return payload;
}

export function buildCompletionInputText(
  request: CompletionRequest,
  options: { apiOptimized: boolean },
): string {
  return JSON.stringify(buildInlineContextPayload(request, options), null, 0);
}

export function buildCodexRequestBodyObject(
  request: CompletionRequest,
  options: BuildCodexRequestBodyOptions,
): Record<string, unknown> {
  const instructions = request.instructions ?? options.instructions;
  const isApiEndpoint = options.endpoint.includes('api.openai.com');
  const inputText = buildCompletionInputText(request, {
    apiOptimized: isApiEndpoint,
  });
  const maxOutputTokens = request.maxOutputTokens ?? options.maxOutputTokens;
  const serviceTier = request.serviceTier ?? options.serviceTier;
  const promptCacheKey = request.promptCacheKey ?? options.promptCacheKey;
  const promptCacheRetention = request.promptCacheRetention ?? options.promptCacheRetention;

  return {
    model: request.model ?? options.model,
    ...(instructions ? { instructions } : {}),
    reasoning: { effort: request.reasoningEffort ?? 'none' },
    text: {
      verbosity: 'low',
    },
    stream: true,
    store: false,
    ...(isApiEndpoint && maxOutputTokens ? { max_output_tokens: maxOutputTokens } : {}),
    ...(isApiEndpoint && serviceTier ? { service_tier: serviceTier } : {}),
    ...(isApiEndpoint && promptCacheKey ? { prompt_cache_key: promptCacheKey } : {}),
    ...(isApiEndpoint && promptCacheRetention
      ? { prompt_cache_retention: promptCacheRetention }
      : {}),
    input: [
      {
        role: 'user',
        content: [{ type: 'input_text', text: inputText }],
      },
    ],
  };
}

export function buildCodexRequestBody(
  request: CompletionRequest,
  options: BuildCodexRequestBodyOptions,
): string {
  return JSON.stringify(buildCodexRequestBodyObject(request, options));
}

function takeLastLines(value: string, maxLines: number): string {
  if (maxLines <= 0) {
    return '';
  }
  const lines = value.split(/\r?\n/);
  return lines.slice(-maxLines).join('\n');
}

function takeFirstLines(value: string, maxLines: number): string {
  if (maxLines <= 0) {
    return '';
  }
  const lines = value.split(/\r?\n/);
  return lines.slice(0, maxLines).join('\n');
}

interface RankedLine {
  distance: number;
  text: string;
}

interface PriorityContext {
  current: string;
  prev: string | null;
  next: string | null;
}

type ContextFocusStrategy = 'window' | 'python_scope' | 'brace_scope';

interface FocusedContextLines {
  strategy: ContextFocusStrategy;
  prefixLines: string[];
  suffixLines: string[];
  headerLine?: string;
}

function splitContextLines(value: string): string[] {
  if (!value) {
    return [];
  }
  return value.split(/\r?\n/);
}

function buildPriorityContext(input: {
  prefixLines: string[];
  suffixLines: string[];
  linePrefix: string;
  lineSuffix: string;
}): PriorityContext {
  const currentLine = `${input.linePrefix}${input.lineSuffix}`;
  const currentLineInPrefix = input.linePrefix.length > 0;
  const previousLineIndex = currentLineInPrefix
    ? input.prefixLines.length - 2
    : input.prefixLines.length - 1;
  const previousLine = getContextLine(input.prefixLines, previousLineIndex);
  const nextLineIndex = input.lineSuffix.length > 0 ? 1 : 0;
  const nextLine = getContextLine(input.suffixLines, nextLineIndex);

  return {
    current: currentLine,
    prev: previousLine,
    next: nextLine,
  };
}

function focusContextLines(
  prefixLines: string[],
  suffixLines: string[],
  languageId: string,
): FocusedContextLines {
  const pythonScoped = extractPythonScopeContext(prefixLines, suffixLines, languageId);
  if (pythonScoped) {
    return pythonScoped;
  }

  const braceScoped = extractBraceScopeContext(prefixLines, suffixLines, languageId);
  if (braceScoped) {
    return braceScoped;
  }

  return {
    strategy: 'window',
    prefixLines: takeLastArrayLines(prefixLines, 48),
    suffixLines: takeFirstArrayLines(suffixLines, 20),
  };
}

function extractPythonScopeContext(
  prefixLines: string[],
  suffixLines: string[],
  languageId: string,
): FocusedContextLines | undefined {
  if (languageId !== 'python') {
    return undefined;
  }

  let scopeStart = -1;
  for (let index = prefixLines.length - 1; index >= 0; index -= 1) {
    if (/^\s*(?:async\s+def|def|class)\b/.test(prefixLines[index])) {
      scopeStart = index;
      break;
    }
  }

  if (scopeStart < 0) {
    return undefined;
  }

  const scopeHeader = prefixLines[scopeStart] ?? '';
  const scopeIndentLength = (scopeHeader.match(/^\s*/) ?? [''])[0].length;
  const scopedPrefix = prefixLines.slice(scopeStart);
  const scopedSuffix: string[] = [];

  for (const line of suffixLines) {
    if (!line.trim()) {
      scopedSuffix.push(line);
      continue;
    }

    const indentLength = (line.match(/^\s*/) ?? [''])[0].length;
    if (indentLength <= scopeIndentLength) {
      break;
    }
    scopedSuffix.push(line);
  }

  return {
    strategy: 'python_scope',
    headerLine: scopeHeader.trim() || scopeHeader,
    prefixLines: takeLastArrayLinesPreservingFirst(scopedPrefix, 48),
    suffixLines: takeFirstArrayLines(scopedSuffix, 20),
  };
}

function extractBraceScopeContext(
  prefixLines: string[],
  suffixLines: string[],
  languageId: string,
): FocusedContextLines | undefined {
  if (!isBraceScopedLanguage(languageId)) {
    return undefined;
  }

  const scopeStart = findBraceScopeStart(prefixLines);
  if (scopeStart < 0) {
    return undefined;
  }

  const scopedPrefix = prefixLines.slice(scopeStart);
  let depth = scopedPrefix.reduce((total, line) => total + netBraceDelta(line), 0);
  if (depth <= 0) {
    return undefined;
  }

  const scopedSuffix: string[] = [];
  for (const line of suffixLines) {
    scopedSuffix.push(line);
    depth += netBraceDelta(line);
    if (depth <= 0) {
      break;
    }
  }

  return {
    strategy: 'brace_scope',
    headerLine: summarizeBraceScopeHeader(prefixLines, scopeStart),
    prefixLines: takeLastArrayLinesPreservingFirst(scopedPrefix, 48),
    suffixLines: takeFirstArrayLines(scopedSuffix, 20),
  };
}

function isBraceScopedLanguage(languageId: string): boolean {
  return languageId === 'typescript'
    || languageId === 'javascript'
    || languageId === 'java'
    || languageId === 'csharp'
    || languageId === 'go'
    || languageId === 'rust';
}

function findBraceScopeStart(prefixLines: string[]): number {
  let neededOpenBraces = 1;
  for (let index = prefixLines.length - 1; index >= 0; index -= 1) {
    const line = prefixLines[index];
    const closeCount = countChar(line, '}');
    const openCount = countChar(line, '{');
    neededOpenBraces += closeCount;
    if (openCount >= neededOpenBraces) {
      return index;
    }
    neededOpenBraces -= openCount;
  }
  return -1;
}

function netBraceDelta(line: string): number {
  return countChar(line, '{') - countChar(line, '}');
}

function countChar(line: string, target: string): number {
  let count = 0;
  for (const char of line) {
    if (char === target) {
      count += 1;
    }
  }
  return count;
}

function takeLastArrayLines(lines: string[], maxLines: number): string[] {
  if (maxLines <= 0 || lines.length === 0) {
    return [];
  }
  return lines.length <= maxLines ? lines : lines.slice(lines.length - maxLines);
}

function takeLastArrayLinesPreservingFirst(lines: string[], maxLines: number): string[] {
  if (maxLines <= 0 || lines.length === 0) {
    return [];
  }
  if (lines.length <= maxLines) {
    return lines;
  }
  if (maxLines === 1) {
    return [lines[0]];
  }
  return [lines[0], ...lines.slice(lines.length - (maxLines - 1))];
}

function takeFirstArrayLines(lines: string[], maxLines: number): string[] {
  if (maxLines <= 0 || lines.length === 0) {
    return [];
  }
  return lines.length <= maxLines ? lines : lines.slice(0, maxLines);
}

function buildScopeContext(
  focusedContext: FocusedContextLines,
): PromptContextPayload['scope_context'] | undefined {
  if (focusedContext.strategy === 'window' || !focusedContext.headerLine) {
    return undefined;
  }

  return {
    strategy: focusedContext.strategy,
    header: truncateChars(focusedContext.headerLine, 160),
  };
}

function summarizeBraceScopeHeader(prefixLines: string[], scopeStart: number): string | undefined {
  const scopeStartLine = prefixLines[scopeStart]?.trim();
  if (!scopeStartLine) {
    return undefined;
  }
  if (scopeStartLine !== '{') {
    return scopeStartLine;
  }

  for (let index = scopeStart - 1; index >= 0; index -= 1) {
    const candidate = prefixLines[index]?.trim();
    if (!candidate || candidate === '{') {
      continue;
    }
    return `${candidate} {`;
  }

  return scopeStartLine;
}

function rankPrefixLines(lines: string[]): RankedLine[] {
  const closestDistance = lines.length - 1;
  return lines.map((text, index) => ({
    distance: index - closestDistance,
    text,
  }));
}

function rankSuffixLines(lines: string[]): RankedLine[] {
  return lines.map((text, index) => ({
    distance: index + 1,
    text,
  }));
}

function interleaveRankedContext(
  prefix: RankedLine[],
  suffix: RankedLine[],
): RankedContextLine[] {
  const ordered: RankedContextLine[] = [];
  const prefixByDistance = new Map<number, RankedLine>();
  for (const entry of prefix) {
    prefixByDistance.set(Math.abs(entry.distance), entry);
  }

  const suffixByDistance = new Map<number, RankedLine>();
  for (const entry of suffix) {
    suffixByDistance.set(entry.distance, entry);
  }

  const maxDistance = Math.max(
    prefix.length > 0 ? Math.abs(prefix[0]?.distance ?? 0) : 0,
    suffix.length > 0 ? suffix[suffix.length - 1]?.distance ?? 0 : 0,
  );

  for (let distance = 0; distance <= maxDistance; distance += 1) {
    const prefixEntry = prefixByDistance.get(distance);
    if (prefixEntry) {
      ordered.push({ ...prefixEntry, side: 'prefix' });
    }

    if (distance === 0) {
      continue;
    }

    const suffixEntry = suffixByDistance.get(distance);
    if (suffixEntry) {
      ordered.push({ ...suffixEntry, side: 'suffix' });
    }
  }

  return ordered;
}

function buildOrderedContext(input: {
  prefix: RankedLine[];
  suffix: RankedLine[];
  linePrefix: string;
}): RankedContextLine[] {
  const ordered = interleaveRankedContext(input.prefix, input.suffix);
  const seen = new Set<string>();
  const selected: RankedContextLine[] = [];
  const pushUnique = (entry: RankedContextLine | undefined): void => {
    if (!entry) {
      return;
    }
    const key = `${entry.side}:${entry.distance}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    selected.push(entry);
  };

  const currentLine = ordered.find((entry) => entry.side === 'prefix' && entry.distance === 0);
  pushUnique(currentLine);

  const trailingPartialIdentifier = getTrailingPartialIdentifier(input.linePrefix);
  if (trailingPartialIdentifier && trailingPartialIdentifier.length >= 3) {
    const candidateLines = ordered
      .filter(
        (entry) =>
          !(entry.side === 'prefix' && entry.distance === 0)
          && findBestPartialContinuationLength(entry.text, trailingPartialIdentifier) !== null,
      )
      .sort((left, right) => {
        const leftLength = findBestPartialContinuationLength(left.text, trailingPartialIdentifier) ?? Number.MAX_SAFE_INTEGER;
        const rightLength = findBestPartialContinuationLength(right.text, trailingPartialIdentifier) ?? Number.MAX_SAFE_INTEGER;
        if (leftLength !== rightLength) {
          return leftLength - rightLength;
        }
        const leftDistance = Math.abs(left.distance);
        const rightDistance = Math.abs(right.distance);
        if (leftDistance !== rightDistance) {
          return leftDistance - rightDistance;
        }
        return left.side.localeCompare(right.side);
      });
    for (const candidate of candidateLines) {
      pushUnique(candidate);
    }
  }

  for (const entry of ordered) {
    pushUnique(entry);
  }

  return selected;
}

function getContextLine(lines: string[], index: number): string | null {
  return lines[index] ?? null;
}

function getTrailingPartialIdentifier(linePrefix: string): string | undefined {
  const trimmed = linePrefix.trimEnd();
  const match = /([A-Za-z_][A-Za-z0-9_]*)$/.exec(trimmed);
  return match?.[1];
}

function findBestPartialContinuationLength(line: string, partial: string): number | null {
  const matches = line.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) ?? [];
  let bestLength: number | null = null;
  for (const token of matches) {
    if (!token.startsWith(partial) || token.length <= partial.length) {
      continue;
    }
    const continuationLength = token.length - partial.length;
    if (bestLength === null || continuationLength < bestLength) {
      bestLength = continuationLength;
    }
  }
  return bestLength;
}

function getTokenBeforeCursor(linePrefix: string): string | undefined {
  const match = /([A-Za-z_][\w]*|[^\s])\s*$/.exec(linePrefix);
  return match?.[1];
}

function classifyInlineTask(input: {
  languageId: string;
  linePrefix: string;
}): PromptContextPayload['task'] | undefined {
  const trimmedLinePrefix = input.linePrefix.trimEnd();
  if (!trimmedLinePrefix) {
    return undefined;
  }

  if (isTypeScriptLikeLanguage(input.languageId) && /`[^`]*\$\{[^}]*$/.test(trimmedLinePrefix)) {
    return 'close_template_interpolation';
  }

  if (isTypeScriptLikeLanguage(input.languageId) && /\.split\(\s*$/.test(trimmedLinePrefix)) {
    return 'complete_split_call';
  }

  if (/\.[A-Za-z_][A-Za-z0-9_]*$/.test(trimmedLinePrefix)) {
    return 'continue_partial_member';
  }

  return undefined;
}

function getCallContext(linePrefix: string): string | undefined {
  const match = /([A-Za-z_][\w.]*)\s*\([^()]*$/.exec(linePrefix);
  return match?.[1];
}

function isTypeScriptLikeLanguage(languageId: string): boolean {
  return languageId === 'javascript'
    || languageId === 'javascriptreact'
    || languageId === 'typescript'
    || languageId === 'typescriptreact';
}

function truncateChars(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return value.slice(0, maxChars);
}

async function delayWithAbort(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    throw new Error('Request cancelled');
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);

    const onAbort = (): void => {
      cleanup();
      reject(new Error('Request cancelled'));
    };

    const cleanup = (): void => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
    };

    signal.addEventListener('abort', onAbort);
  });
}
