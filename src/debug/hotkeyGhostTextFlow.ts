import { AIProvider, CompletionRequestTelemetry } from '../api/aiProvider';
import {
  CompletionPayload,
  CompletionPipeline,
  StageTelemetryEvent,
} from '../completion/completionPipeline';
import { buildLatencyBudget } from '../completion/latencyBudget';
import { postProcessGhostTextSuggestion } from '../completion/ghostTextPostProcessor';
import {
  buildCompletionRequestLogFields,
  formatCompletionRequestLogFields,
  NormalizedInlineRequestContext,
} from '../completion/requestDiagnostics';
import { buildResolvedStageRequests } from '../completion/stageRequestFactory';
import { INLINE_PROVIDER_INTERNAL_DEFAULTS, WORKSPACE_SETTING_DEFAULTS } from '../configDefaults';
import { CodexLogStatsSnapshot, codexLog, getCodexLogStatsSnapshot } from '../logging/codexLogger';

const DEFAULT_EMPTY_HOTKEY_RETRIGGERS = 1;

export interface HotkeyGhostTextFlowInput {
  provider: AIProvider;
  source: string;
  editorKey: string;
  contextHash: string;
  requestContext: NormalizedInlineRequestContext;
  rowLanguageId: string;
  rowFilePath: string;
  instructions: string;
  instructionsPrebuilt?: boolean;
  maxOutputTokens?: number;
  serviceTier?: string;
  promptCacheKey?: string;
  promptCacheRetention?: string;
  hotkeyMaxLatencyMs?: number;
  hotkeyFirstChunkMaxLatencyMs?: number;
  hotkeyFastStageMaxLatencyMs?: number;
  hotkeyFastStagePrefixLines?: number;
  hotkeyFastStageSuffixLines?: number;
  hotkeySemanticRetryEnabled?: boolean;
  hotkeySemanticRetryMaxLatencyMs?: number;
  hotkeySemanticRetryFirstChunkMaxLatencyMs?: number;
  maxEmptyHotkeyRetriggers?: number;
}

export interface HotkeyGhostTextLoggingImpact {
  info: {
    emitted: number;
    suppressed: number;
    emitTimeMs: number;
  };
  debug: {
    emitted: number;
    suppressed: number;
    emitTimeMs: number;
  };
}

export interface HotkeyGhostTextFlowResult {
  responseText: string;
  firstChunkMs?: number;
  totalDurationMs: number;
  hotkeyPressToAcceptMs?: number;
  status: 'success' | 'empty' | 'error';
  providerTelemetry?: CompletionRequestTelemetry;
  stageEvents: StageTelemetryEvent[];
  estimatedRequest: CompletionPayload;
  attempts: number;
  completedContextHashHit: boolean;
  timedOutBeforeFirstChunk: boolean;
  repairedFrom?: string;
  repairReasons?: string[];
  timeoutFallback?: string;
  loggingImpact?: HotkeyGhostTextLoggingImpact;
}

export async function runHotkeyGhostTextFlow(
  input: HotkeyGhostTextFlowInput,
): Promise<HotkeyGhostTextFlowResult> {
  const startedAtMs = Date.now();
  const logStatsStarted = getCodexLogStatsSnapshot();
  codexLog(
    `[codex] hotkey ghost-text pressed editor=${input.editorKey} contextHash=${input.contextHash}`,
  );
  let firstChunkMs: number | undefined;
  let providerTelemetry: CompletionRequestTelemetry | undefined;
  let telemetryRequest: CompletionPayload | undefined;
  const stageEvents: StageTelemetryEvent[] = [];
  const maxAttempts = 1 + Math.max(0, input.maxEmptyHotkeyRetriggers ?? DEFAULT_EMPTY_HOTKEY_RETRIGGERS);

  const baseStageRequests = buildResolvedStageRequests({
    context: {
      prefix: input.requestContext.prefix,
      suffix: input.requestContext.suffix,
      linePrefix: input.requestContext.linePrefix,
      lineSuffix: input.requestContext.lineSuffix,
      languageId: input.rowLanguageId,
      filePath: input.rowFilePath,
    },
    dynamicCacheKey: input.promptCacheKey,
    config: {
      fastStagePrefixLines:
        input.hotkeyFastStagePrefixLines ?? INLINE_PROVIDER_INTERNAL_DEFAULTS.fastStagePrefixLines,
      fastStageSuffixLines:
        input.hotkeyFastStageSuffixLines ?? INLINE_PROVIDER_INTERNAL_DEFAULTS.fastStageSuffixLines,
      instructions: input.instructions,
      instructionsPrebuilt: input.instructionsPrebuilt,
      maxOutputTokens: input.maxOutputTokens,
      serviceTier: input.serviceTier,
      promptCacheRetention: input.promptCacheRetention,
    },
    interactionMode: 'hotkey',
    fullContextFactory: async (): Promise<string | undefined> => input.requestContext.context,
  });

  const fastRequest: CompletionPayload = {
    ...baseStageRequests.fastRequest,
    onTelemetry: (telemetry: CompletionRequestTelemetry) => {
      providerTelemetry = telemetry;
      telemetryRequest = fastRequest;
    },
  };

  let fullRequestCache: CompletionPayload | undefined;
  const getFullRequest = async (): Promise<CompletionPayload> => {
    if (!fullRequestCache) {
      const fullRequest = await baseStageRequests.fullRequestFactory();
      fullRequestCache = {
        ...fullRequest,
        onTelemetry: (telemetry: CompletionRequestTelemetry) => {
          providerTelemetry = telemetry;
          telemetryRequest = fullRequestCache;
        },
      };
    }
    return fullRequestCache;
  };

  codexLog(
    `[codex] hotkey ghost-text flow ${formatCompletionRequestLogFields(
      buildCompletionRequestLogFields(fastRequest, {
        source: input.source,
        benchmarkMode: 'hotkey_inline',
        stage: 'fast',
        editorKey: input.editorKey,
        contextHash: input.contextHash,
      }),
    )}`,
  );

  const latencyBudget = buildLatencyBudget(
    {
      maxLatencyMs: input.hotkeyMaxLatencyMs ?? WORKSPACE_SETTING_DEFAULTS.maxLatencyMs,
      firstChunkMaxLatencyMs:
        input.hotkeyFirstChunkMaxLatencyMs ?? WORKSPACE_SETTING_DEFAULTS.firstChunkMaxLatencyMs,
      fastStageMaxLatencyMs:
        input.hotkeyFastStageMaxLatencyMs ?? INLINE_PROVIDER_INTERNAL_DEFAULTS.fastStageMaxLatencyMs,
    },
  );

  codexLog(
    `[codex] hotkey ghost-text latency max=${latencyBudget.maxLatencyMs}ms firstChunk=${latencyBudget.firstChunkMaxLatencyMs}ms fast=${latencyBudget.fastStageMaxLatencyMs}ms semanticRetryEnabled=${input.hotkeySemanticRetryEnabled ?? INLINE_PROVIDER_INTERNAL_DEFAULTS.hotkeySemanticRetryEnabled}`,
  );

  const pipeline = new CompletionPipeline(
    input.provider,
    () => {
      if (firstChunkMs === undefined) {
        firstChunkMs = Date.now() - startedAtMs;
      }
    },
    (event) => stageEvents.push(event),
  );

  try {
    let attemptsUsed = 0;
    let responseText = '';
    let repairedFrom: string | undefined;
    let repairReasons: string[] | undefined;
    let timeoutFallback: string | undefined;
    let completedContextHashHit = false;
    let timedOutBeforeFirstChunk = false;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      attemptsUsed = attempt;
      const suggestionResult = await pipeline.getSuggestion({
        editorKey: input.editorKey,
        contextHash: input.contextHash,
        fastRequest,
        fullRequestFactory: getFullRequest,
        latencyBudget,
        skipFastStage: false,
        hotkeySemanticRetry: {
          enabled:
            input.hotkeySemanticRetryEnabled
            ?? INLINE_PROVIDER_INTERNAL_DEFAULTS.hotkeySemanticRetryEnabled,
          maxLatencyMs:
            input.hotkeySemanticRetryMaxLatencyMs
            ?? INLINE_PROVIDER_INTERNAL_DEFAULTS.hotkeySemanticRetryMaxLatencyMs,
          firstChunkMaxLatencyMs:
            input.hotkeySemanticRetryFirstChunkMaxLatencyMs
            ?? INLINE_PROVIDER_INTERNAL_DEFAULTS.hotkeySemanticRetryFirstChunkMaxLatencyMs,
        },
        signal: new AbortController().signal,
      });

      completedContextHashHit = suggestionResult.completedContextHashHit;
      timedOutBeforeFirstChunk = suggestionResult.timedOutBeforeFirstChunk;

      const processedSuggestion = postProcessGhostTextSuggestion({
        suggestion: suggestionResult.suggestion,
        timedOutBeforeFirstChunk: suggestionResult.timedOutBeforeFirstChunk,
        prefix: input.requestContext.prefix,
        suffix: input.requestContext.suffix,
        filePath: input.rowFilePath,
        linePrefix: input.requestContext.linePrefix,
        lineSuffix: input.requestContext.lineSuffix,
        languageId: input.rowLanguageId,
        beforeLines: input.requestContext.beforeLines,
      });
      responseText = processedSuggestion.text;
      repairedFrom = processedSuggestion.repairedFrom;
      repairReasons = processedSuggestion.repairReasons;
      timeoutFallback = processedSuggestion.timeoutFallback;

      if (processedSuggestion.repairedFrom !== undefined) {
        const repairReasonSuffix = processedSuggestion.repairReasons?.length
          ? ` reasons=${JSON.stringify(processedSuggestion.repairReasons)}`
          : '';
        codexLog(
          `[codex] hotkey ghost-text repaired ${JSON.stringify(processedSuggestion.repairedFrom)} -> ${JSON.stringify(processedSuggestion.text)}${repairReasonSuffix}`,
        );
      }
      if (processedSuggestion.timeoutFallback) {
        codexLog(
          `[codex] hotkey ghost-text timeout fallback used ${JSON.stringify(processedSuggestion.timeoutFallback)}`,
        );
      }
      codexLog(`[codex] hotkey ghost-text suggestion ${JSON.stringify(responseText)}`);

      if (
        responseText.trim()
        || completedContextHashHit
        || attempt >= maxAttempts
      ) {
        const hotkeyPressToAcceptMs = responseText.trim()
          ? (Date.now() - startedAtMs)
          : undefined;
        if (hotkeyPressToAcceptMs !== undefined) {
          codexLog(
            `[codex] hotkey ghost-text accepted editor=${input.editorKey} contextHash=${input.contextHash} acceptMs=${hotkeyPressToAcceptMs}ms attempts=${attemptsUsed}`,
          );
        }
        return {
          responseText,
          firstChunkMs,
          totalDurationMs: Date.now() - startedAtMs,
          hotkeyPressToAcceptMs,
          status: responseText.trim() ? 'success' : 'empty',
          providerTelemetry,
          stageEvents,
          estimatedRequest: telemetryRequest ?? await chooseEstimatedRequestForHotkeyRun({
            stageEvents,
            fastRequest,
            fullRequestFactory: getFullRequest,
          }),
          attempts: attemptsUsed,
          completedContextHashHit,
          timedOutBeforeFirstChunk,
          repairedFrom,
          repairReasons,
          timeoutFallback,
          loggingImpact: computeHotkeyLoggingImpact(logStatsStarted),
        };
      }

      pipeline.clearSuggestionState(input.editorKey);
      codexLog(
        `[codex] hotkey ghost-text retriggered after empty result attempt=${attempt + 1}/${maxAttempts}`,
      );
    }

    return {
      responseText: '',
      firstChunkMs,
      totalDurationMs: Date.now() - startedAtMs,
      hotkeyPressToAcceptMs: undefined,
      status: 'empty',
      providerTelemetry,
      stageEvents,
      estimatedRequest: telemetryRequest ?? await chooseEstimatedRequestForHotkeyRun({
        stageEvents,
        fastRequest,
        fullRequestFactory: getFullRequest,
      }),
      attempts: maxAttempts,
      completedContextHashHit: false,
      timedOutBeforeFirstChunk: false,
      loggingImpact: computeHotkeyLoggingImpact(logStatsStarted),
    };
  } catch (error) {
    const message = formatErrorWithCauses(error);
    return {
      responseText: `[ERROR] ${message}`,
      firstChunkMs,
      totalDurationMs: Date.now() - startedAtMs,
      hotkeyPressToAcceptMs: undefined,
      status: 'error',
      providerTelemetry,
      stageEvents,
      estimatedRequest: telemetryRequest ?? await chooseEstimatedRequestForHotkeyRun({
        stageEvents,
        fastRequest,
        fullRequestFactory: getFullRequest,
      }),
      attempts: 1,
      completedContextHashHit: false,
      timedOutBeforeFirstChunk: false,
      loggingImpact: computeHotkeyLoggingImpact(logStatsStarted),
    };
  } finally {
    pipeline.dispose();
  }
}


function computeHotkeyLoggingImpact(
  started: CodexLogStatsSnapshot,
): HotkeyGhostTextLoggingImpact {
  const ended = getCodexLogStatsSnapshot();
  return {
    info: {
      emitted: Math.max(0, ended.levels.info.emitted - started.levels.info.emitted),
      suppressed: Math.max(0, ended.levels.info.suppressed - started.levels.info.suppressed),
      emitTimeMs: Math.max(0, ended.levels.info.emitTimeMs - started.levels.info.emitTimeMs),
    },
    debug: {
      emitted: Math.max(0, ended.levels.debug.emitted - started.levels.debug.emitted),
      suppressed: Math.max(0, ended.levels.debug.suppressed - started.levels.debug.suppressed),
      emitTimeMs: Math.max(0, ended.levels.debug.emitTimeMs - started.levels.debug.emitTimeMs),
    },
  };
}

async function chooseEstimatedRequestForHotkeyRun(input: {
  stageEvents: StageTelemetryEvent[];
  fastRequest: CompletionPayload;
  fullRequestFactory: () => Promise<CompletionPayload>;
}): Promise<CompletionPayload> {
  const fastHit = input.stageEvents.some((event) =>
    event.stage === 'fast' && event.outcome === 'hit');
  if (fastHit) {
    return input.fastRequest;
  }

  const fullCompleted = input.stageEvents.some((event) =>
    event.stage === 'full' && event.outcome === 'completed');
  if (fullCompleted) {
    return input.fullRequestFactory();
  }

  return input.fastRequest;
}

function formatErrorWithCauses(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'Unknown error';
  }

  const parts: string[] = [];
  let current: unknown = error;
  let depth = 0;

  while (current instanceof Error && depth < 4) {
    const currentWithCode = current as Error & { code?: unknown; cause?: unknown };
    const rawMessage = typeof current.message === 'string' && current.message.trim().length > 0
      ? current.message.trim()
      : current.name;
    const codePrefix = typeof currentWithCode.code === 'string' && currentWithCode.code.length > 0
      ? `${currentWithCode.code} `
      : '';
    const detail = `${codePrefix}${rawMessage}`.trim();
    if (!parts.includes(detail)) {
      parts.push(detail);
    }
    current = currentWithCode.cause;
    depth += 1;
  }

  if (parts.length === 0) {
    return 'Unknown error';
  }

  if (parts.length === 1) {
    return parts[0];
  }

  return `${parts[0]} | cause: ${parts.slice(1).join(' | cause: ')}`;
}
