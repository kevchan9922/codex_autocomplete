import { AIProvider, CompletionRequestTelemetry } from '../api/aiProvider';
import { mergeAbortSignals, isRequestCancelled } from './abortUtils';
import { codexDebug, codexLog } from '../logging/codexLogger';
import {
  buildCompletionRequestLogFields,
  formatCompletionRequestLogFields,
} from './requestDiagnostics';
import {
  buildHotkeyBlankRetryInstructions,
  buildHotkeySemanticRetryInstructions,
  extractRelevantIdentifiers,
  extractRelevantStringLiterals,
} from './completionInstructions';
import {
  BlankLineHeuristicDecision,
  classifyGenericBlankLinePlaceholder as classifyGenericBlankLineSuggestion,
  getExactNearbyBlankLineDuplicate,
  isBlankLineAtCursor,
  looksLikeBlankLineCarryoverFragment,
  looksLikeStandaloneCodeStatement,
} from './blankLineHeuristics';
import { getStructuralCursorLinePrefix } from './blankLineContinuation';
import {
  LatencyBudget,
  StageLatencyBudget,
  normalizeStageLatencyBudget,
} from './latencyBudget';
import { takeFirstLines, takeLastLines } from './inlineTextUtils';

export interface CompletionPayload {
  prefix: string;
  suffix: string;
  linePrefix?: string;
  lineSuffix?: string;
  selection?: string;
  languageId: string;
  filePath: string;
  context: string | undefined;
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

export interface StageTelemetryEvent {
  stage: 'fast' | 'full';
  outcome: 'hit' | 'empty' | 'error' | 'completed';
  latencyMs: number;
  reason?: 'hotkey_direct' | 'fallback_after_empty' | 'fallback_after_error';
}

export interface CompletionAttempt {
  suggestion: string;
  timedOutBeforeFirstChunk: boolean;
  timedOut: boolean;
}

const PARTIAL_RETURN_DEADLINE_GRACE_MS = 80;
const HOTKEY_FULL_STAGE_FIRST_CHUNK_AFTER_FAST_TIMEOUT_MS = 1200;
const MIN_FULL_STAGE_FALLBACK_FIRST_CHUNK_MS = 1000;
const FIRST_CHUNK_PROGRESS_EXTENSION_MS = 1200;
const MAX_FIRST_CHUNK_PROGRESS_EXTENSIONS = 2;

interface InFlightCompletion {
  hash: string;
  controller: AbortController;
  promise: Promise<CompletionAttempt>;
}

export interface SuggestionRequest {
  editorKey: string;
  contextHash: string;
  fastRequest: CompletionPayload;
  fullRequestFactory: () => Promise<CompletionPayload>;
  latencyBudget: LatencyBudget;
  skipFastStage: boolean;
  hotkeySemanticRetry?: {
    enabled: boolean;
    retryOnEmpty?: boolean;
    maxLatencyMs: number;
    firstChunkMaxLatencyMs: number;
  };
  signal: AbortSignal;
}

export interface SuggestionResult {
  suggestion: string;
  completedContextHashHit: boolean;
  timedOutBeforeFirstChunk: boolean;
  timedOut: boolean;
}

export class CompletionPipeline {
  private readonly inFlightByEditor = new Map<string, InFlightCompletion>();

  constructor(
    private readonly provider: AIProvider,
    private readonly onFirstChunkLatency?: (valueMs: number) => void,
    private readonly onStageTelemetry?: (event: StageTelemetryEvent) => void,
  ) {}

  async getSuggestion(request: SuggestionRequest): Promise<SuggestionResult> {
    const completionPromise = this.startInFlight(
      request.editorKey,
      request.contextHash,
      request.fastRequest,
      request.fullRequestFactory,
      request.latencyBudget,
      request.skipFastStage,
      request.hotkeySemanticRetry,
    );

    const completion = await this.awaitWithCancellation(completionPromise, request.signal);
    return {
      suggestion: completion.suggestion,
      completedContextHashHit: false,
      timedOutBeforeFirstChunk: completion.timedOutBeforeFirstChunk,
      timedOut: completion.timedOut,
    };
  }

  async runHotkeyDuplicateRetry(input: {
    request: CompletionPayload;
    previousAttempt: string;
    forbiddenDuplicate: string;
    maxLatencyMs: number;
    firstChunkMaxLatencyMs: number;
    signal: AbortSignal;
  }): Promise<CompletionAttempt> {
    const retryRequest = this.buildHotkeySemanticRetryRequest(
      input.request,
      input.previousAttempt,
      input.forbiddenDuplicate,
    );
    const semanticRetryBudget = normalizeStageLatencyBudget({
      maxLatencyMs: input.maxLatencyMs,
      firstChunkMaxLatencyMs: input.firstChunkMaxLatencyMs,
    });
    return this.runCompletion(
      retryRequest,
      input.signal,
      semanticRetryBudget,
      'hotkey_semantic_retry',
    );
  }

  recordAcceptedSuggestion(_editorKey: string, _contextHash: string, _suggestion: string): void {}

  clearSuggestionState(_editorKey: string): void {}

  clearEditor(editorKey: string): void {
    const existing = this.inFlightByEditor.get(editorKey);
    if (existing) {
      existing.controller.abort();
      this.inFlightByEditor.delete(editorKey);
    }
    this.clearSuggestionState(editorKey);
  }

  dispose(): void {
    for (const inFlight of this.inFlightByEditor.values()) {
      inFlight.controller.abort();
    }
    this.inFlightByEditor.clear();
  }

  private startInFlight(
    editorKey: string,
    contextHash: string,
    fastRequest: CompletionPayload,
    fullRequestFactory: () => Promise<CompletionPayload>,
    latencyBudget: LatencyBudget,
    skipFastStage: boolean,
    hotkeySemanticRetry: SuggestionRequest['hotkeySemanticRetry'],
  ): Promise<CompletionAttempt> {
    const existing = this.inFlightByEditor.get(editorKey);
    if (existing) {
      existing.controller.abort();
      this.inFlightByEditor.delete(editorKey);
    }

    const controller = new AbortController();
    const promise = (async () => this.runTwoStageCompletion(
      editorKey,
      contextHash,
      fastRequest,
      fullRequestFactory,
      controller.signal,
      latencyBudget,
      skipFastStage,
      hotkeySemanticRetry,
    ))();

    const tracked: InFlightCompletion = { hash: contextHash, controller, promise };
    this.inFlightByEditor.set(editorKey, tracked);

    promise.finally(() => {
      const current = this.inFlightByEditor.get(editorKey);
      if (current?.promise === promise) {
        this.inFlightByEditor.delete(editorKey);
      }
    }).catch(() => undefined);

    return promise;
  }

  private async runTwoStageCompletion(
    editorKey: string,
    contextHash: string,
    fastRequest: CompletionPayload,
    fullRequestFactory: () => Promise<CompletionPayload>,
    signal: AbortSignal,
    latencyBudget: LatencyBudget,
    skipFastStage: boolean,
    hotkeySemanticRetry: SuggestionRequest['hotkeySemanticRetry'],
  ): Promise<CompletionAttempt> {
    const overallStartedAt = Date.now();
    if (skipFastStage) {
      if (signal.aborted) {
        throw new Error('Request cancelled');
      }
      codexLog('[codex] hotkey mode: skipping fast-stage and running full-context completion');
      const fullStartedAt = Date.now();
      const fullRequest = await fullRequestFactory();
      const directFullStageBudget = normalizeStageLatencyBudget({
        maxLatencyMs: latencyBudget.maxLatencyMs,
        firstChunkMaxLatencyMs: latencyBudget.firstChunkMaxLatencyMs,
      });
      this.logStageRequest('full', fullRequest, editorKey, contextHash);
      const fullResult = await this.runCompletion(
        fullRequest,
        signal,
        directFullStageBudget,
        'full',
      );
      this.onStageTelemetry?.({
        stage: 'full',
        outcome: 'completed',
        latencyMs: Date.now() - fullStartedAt,
        reason: 'hotkey_direct',
      });
      return this.maybeRunHotkeySemanticRetry(
        fullRequest,
        fullResult,
        hotkeySemanticRetry,
        signal,
      );
    }

    const fastStageBudget = normalizeStageLatencyBudget({
      maxLatencyMs: latencyBudget.fastStageMaxLatencyMs,
      firstChunkMaxLatencyMs: latencyBudget.firstChunkMaxLatencyMs,
    });
    let preparedFullRequestPromise: Promise<CompletionPayload>;
    try {
      preparedFullRequestPromise = fullRequestFactory();
    } catch (error) {
      preparedFullRequestPromise = Promise.reject(error);
    }
    // Prewarm full-stage request construction during fast-stage streaming to reduce fallback delay.
    preparedFullRequestPromise.catch(() => undefined);
    let fastResult: CompletionAttempt = { suggestion: '', timedOutBeforeFirstChunk: false, timedOut: false };
    let fallbackReason: StageTelemetryEvent['reason'];
    const fastStageStartedAt = Date.now();
    try {
      this.logStageRequest('fast', fastRequest, editorKey, contextHash);
      fastResult = await this.runCompletion(
        fastRequest,
        signal,
        fastStageBudget,
        'fast',
      );
    } catch (error) {
      if (isRequestCancelled(error) && signal.aborted) {
        throw error;
      }
      this.onStageTelemetry?.({
        stage: 'fast',
        outcome: 'error',
        latencyMs: Date.now() - fastStageStartedAt,
      });
      fallbackReason = 'fallback_after_error';
      codexLog('[codex] fast-stage failed, falling back to full-context completion');
    }
    if (fastResult.suggestion.trim()) {
      const settledFastResult = await this.maybeRunHotkeySemanticRetry(
        fastRequest,
        fastResult,
        hotkeySemanticRetry,
        signal,
      );
      const semanticRetryDroppedFastSuggestion =
        !settledFastResult.suggestion.trim() && fastResult.suggestion.trim();
      if (settledFastResult.suggestion.trim()) {
        this.onStageTelemetry?.({
          stage: 'fast',
          outcome: 'hit',
          latencyMs: Date.now() - fastStageStartedAt,
        });
        codexLog('[codex] fast-stage completion used');
        return settledFastResult;
      }

      this.onStageTelemetry?.({
        stage: 'fast',
        outcome: 'empty',
        latencyMs: Date.now() - fastStageStartedAt,
      });
      fallbackReason = 'fallback_after_empty';
      fastResult = settledFastResult;
      codexLog(
        semanticRetryDroppedFastSuggestion
          ? '[codex] fast-stage suggestion dropped after semantic retry, falling back to full-context completion'
          : '[codex] fast-stage suggestion rejected after semantic retry, falling back to full-context completion',
      );
    }
    if (!fallbackReason) {
      this.onStageTelemetry?.({
        stage: 'fast',
        outcome: 'empty',
        latencyMs: Date.now() - fastStageStartedAt,
      });
      fallbackReason = 'fallback_after_empty';
    }

    if (signal.aborted) {
      throw new Error('Request cancelled');
    }

    const elapsedBeforeFullMs = Date.now() - overallStartedAt;
    const remainingMaxLatencyMs = latencyBudget.maxLatencyMs - elapsedBeforeFullMs;
    const remainingFirstChunkLatencyMs = latencyBudget.firstChunkMaxLatencyMs - elapsedBeforeFullMs;
    const hotkeyRefundFastStageBudget =
      fastRequest.interactionMode === 'hotkey' && fastResult.timedOutBeforeFirstChunk;
    if (!hotkeyRefundFastStageBudget && remainingMaxLatencyMs <= 0) {
      codexLog(
        `[codex] shared latency deadline reached before full-stage fallback elapsed=${elapsedBeforeFullMs}ms max=${latencyBudget.maxLatencyMs}ms`,
      );
      return {
        suggestion: '',
        timedOutBeforeFirstChunk: fastResult.timedOutBeforeFirstChunk,
        timedOut: fastResult.timedOut,
      };
    }

    codexLog('[codex] fast-stage empty, running full-context completion');
    const fullStageStartedAt = Date.now();
    const fullRequest = await preparedFullRequestPromise;
    this.logStageRequest('full', fullRequest, editorKey, contextHash);
    let fullStageFirstChunkBudgetMs = fastResult.timedOutBeforeFirstChunk
      ? hotkeyRefundFastStageBudget
        ? latencyBudget.firstChunkMaxLatencyMs
        : Math.min(
          remainingFirstChunkLatencyMs,
          HOTKEY_FULL_STAGE_FIRST_CHUNK_AFTER_FAST_TIMEOUT_MS,
        )
      : remainingFirstChunkLatencyMs;
    if (!hotkeyRefundFastStageBudget && remainingMaxLatencyMs > 0) {
      const fallbackFirstChunkFloorMs = Math.min(
        remainingMaxLatencyMs,
        MIN_FULL_STAGE_FALLBACK_FIRST_CHUNK_MS,
      );
      if (fullStageFirstChunkBudgetMs < fallbackFirstChunkFloorMs) {
        codexLog(
          `[codex] full-stage first-chunk timeout floor applied floor=${fallbackFirstChunkFloorMs}ms requested=${fullStageFirstChunkBudgetMs}ms remaining=${remainingMaxLatencyMs}ms`,
        );
        fullStageFirstChunkBudgetMs = fallbackFirstChunkFloorMs;
      }
    }
    const fullStageBudget = normalizeStageLatencyBudget({
      maxLatencyMs: hotkeyRefundFastStageBudget ? latencyBudget.maxLatencyMs : remainingMaxLatencyMs,
      firstChunkMaxLatencyMs: fullStageFirstChunkBudgetMs,
    });
    if (hotkeyRefundFastStageBudget) {
      codexLog(
        `[codex] hotkey full-stage budget reset after fast-stage first-chunk timeout full=${fullStageBudget.maxLatencyMs}ms firstChunk=${fullStageBudget.firstChunkMaxLatencyMs}ms`,
      );
    }
    if (
      fastResult.timedOutBeforeFirstChunk
      && fullStageBudget.firstChunkMaxLatencyMs < remainingFirstChunkLatencyMs
    ) {
      codexLog(
        `[codex] full-stage first-chunk timeout capped after fast-stage timeout cap=${fullStageBudget.firstChunkMaxLatencyMs}ms remaining=${remainingFirstChunkLatencyMs}ms`,
      );
    }
    const fullResult = await this.runCompletion(
      fullRequest,
      signal,
      fullStageBudget,
      'full',
    );
    this.onStageTelemetry?.({
      stage: 'full',
      outcome: 'completed',
      latencyMs: Date.now() - fullStageStartedAt,
      reason: fallbackReason,
    });
    return this.maybeRunHotkeySemanticRetry(
      fullRequest,
      fullResult,
      hotkeySemanticRetry,
      signal,
    );
  }

  private async runCompletion(
    request: CompletionPayload,
    signal: AbortSignal,
    budget: StageLatencyBudget,
    stage: 'fast' | 'full' | 'hotkey_semantic_retry',
  ): Promise<CompletionAttempt> {
    const startedAt = Date.now();
    const deadlineAt = startedAt + budget.maxLatencyMs;
    const timeoutController = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let firstChunkTimeoutId: ReturnType<typeof setTimeout> | undefined;
    const combinedSignal = mergeAbortSignals(signal, timeoutController.signal);

    let suggestion = '';
    let firstChunkSeen = false;
    let chunkCount = 0;
    let progressExtensionCount = 0;
    let firstChunkTimerFired = false;
    let totalTimeoutTimerFired = false;
    let firstChunkDeadlineAt = startedAt + budget.firstChunkMaxLatencyMs;
    timeoutId = setTimeout(() => {
      totalTimeoutTimerFired = true;
      codexLog(
        `[codex] ${stage} max-latency timer fired elapsed=${Date.now() - startedAt}ms budget=${budget.maxLatencyMs}ms`,
      );
      timeoutController.abort();
    }, budget.maxLatencyMs);
    firstChunkTimeoutId = setTimeout(() => {
      firstChunkTimerFired = true;
      const effectiveDeadlineMs = Math.max(
        budget.firstChunkMaxLatencyMs,
        Math.round(firstChunkDeadlineAt - startedAt),
      );
      codexLog(
        `[codex] ${stage} first-chunk timer fired elapsed=${Date.now() - startedAt}ms effectiveDeadline=${effectiveDeadlineMs}ms base=${budget.firstChunkMaxLatencyMs}ms extensions=${progressExtensionCount}`,
      );
      timeoutController.abort();
    }, budget.firstChunkMaxLatencyMs);

    try {
      for await (const chunk of this.provider.streamCompletion(request, combinedSignal)) {
        if (combinedSignal.aborted) {
          break;
        }

        if (chunk.done) {
          break;
        }

        if (chunk.progress && !firstChunkSeen) {
          if (firstChunkTimeoutId && progressExtensionCount < MAX_FIRST_CHUNK_PROGRESS_EXTENSIONS) {
            const remainingMs = Math.max(1, deadlineAt - Date.now());
            const extensionMs = Math.max(
              1,
              Math.min(FIRST_CHUNK_PROGRESS_EXTENSION_MS, remainingMs),
            );
            const candidateDeadlineAt = Math.min(
              deadlineAt,
              Math.max(Date.now(), firstChunkDeadlineAt) + extensionMs,
            );
            if (candidateDeadlineAt <= firstChunkDeadlineAt + 10) {
              continue;
            }
            clearTimeout(firstChunkTimeoutId);
            const nextTimeoutMs = Math.max(1, candidateDeadlineAt - Date.now());
            firstChunkTimeoutId = setTimeout(() => {
              firstChunkTimerFired = true;
              timeoutController.abort();
            }, nextTimeoutMs);
            firstChunkDeadlineAt = candidateDeadlineAt;
            progressExtensionCount += 1;
            codexLog(
              `[codex] first-chunk timeout extended due to stream progress extension=${nextTimeoutMs}ms count=${progressExtensionCount}`,
            );
          }
          continue;
        }

        if (!firstChunkSeen) {
          firstChunkSeen = true;
          this.onFirstChunkLatency?.(Date.now() - startedAt);
          if (firstChunkTimeoutId) {
            clearTimeout(firstChunkTimeoutId);
            firstChunkTimeoutId = undefined;
          }
        }

        suggestion += chunk.text;
        if (chunk.text) {
          chunkCount += 1;
          const remainingMs = deadlineAt - Date.now();
          if (suggestion.trim() && remainingMs <= PARTIAL_RETURN_DEADLINE_GRACE_MS) {
            codexLog(
              `[codex] returning suggestion near max latency deadline remaining=${Math.max(0, remainingMs)}ms`,
            );
            return {
              suggestion,
              timedOutBeforeFirstChunk: false,
              timedOut: false,
            };
          }
        }
      }
    } catch (err) {
      if (isRequestCancelled(err)) {
        if (timeoutController.signal.aborted) {
          const elapsedMs = Date.now() - startedAt;
          const timeoutSource = firstChunkSeen
            ? (totalTimeoutTimerFired ? 'max_latency' : 'unknown')
            : (totalTimeoutTimerFired ? 'first_chunk_or_max_latency' : 'first_chunk');
          codexLog(
            `[codex] inline completion cancelled by latency guard elapsed=${elapsedMs}ms firstChunkSeen=${firstChunkSeen} chunkCount=${chunkCount} suggestionChars=${suggestion.length} firstChunkTimerFired=${firstChunkTimerFired} totalTimeoutTimerFired=${totalTimeoutTimerFired}`,
          );
          codexLog(`[codex] inline timeout source=${timeoutSource}`);
          if (!firstChunkSeen) {
            const effectiveDeadlineMs = Math.max(
              budget.firstChunkMaxLatencyMs,
              Math.round(firstChunkDeadlineAt - startedAt),
            );
            codexLog(
              `[codex] inline timeout before first chunk effectiveDeadline=${effectiveDeadlineMs}ms base=${budget.firstChunkMaxLatencyMs}ms extensions=${progressExtensionCount}`,
            );
          }
          if (totalTimeoutTimerFired) {
            codexLog(`[codex] inline timeout max latency reached (${budget.maxLatencyMs}ms)`);
          }
          if (!firstChunkTimerFired && !totalTimeoutTimerFired) {
            codexLog('[codex] inline timeout source unknown (internal abort controller)');
          }
          if (suggestion.trim()) {
            return {
              suggestion,
              timedOutBeforeFirstChunk: false,
              timedOut: true,
            };
          }
          return {
            suggestion: '',
            timedOutBeforeFirstChunk: !firstChunkSeen,
            timedOut: true,
          };
        }
        const elapsedMs = Date.now() - startedAt;
        codexLog(
          `[codex] inline completion cancelled by external signal elapsed=${elapsedMs}ms firstChunkSeen=${firstChunkSeen} chunkCount=${chunkCount} suggestionChars=${suggestion.length}`,
        );
        throw err;
      }
      throw err;
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (firstChunkTimeoutId) {
        clearTimeout(firstChunkTimeoutId);
      }
    }

    if (combinedSignal.aborted && !timeoutController.signal.aborted) {
      throw new Error('Request cancelled');
    }

    return {
      suggestion,
      timedOutBeforeFirstChunk: false,
      timedOut: false,
    };
  }

  private async awaitWithCancellation(
    promise: Promise<CompletionAttempt>,
    signal: AbortSignal,
  ): Promise<CompletionAttempt> {
    if (signal.aborted) {
      throw new Error('Request cancelled');
    }

    let aborted = false;
    let abortHandler: (() => void) | undefined;

    const cancellationPromise = new Promise<CompletionAttempt>((_, reject) => {
      abortHandler = () => {
        if (aborted) {
          return;
        }
        aborted = true;
        reject(new Error('Request cancelled'));
      };

      signal.addEventListener('abort', abortHandler);
    });

    try {
      return await Promise.race([promise, cancellationPromise]);
    } finally {
      if (abortHandler) {
        signal.removeEventListener('abort', abortHandler);
      }
    }
  }

  private logStageRequest(
    stage: 'fast' | 'full',
    request: CompletionPayload,
    editorKey: string,
    contextHash: string,
  ): void {
    const fields = buildCompletionRequestLogFields(request, {
      source: 'completion_pipeline',
      stage,
      editorKey,
      contextHash,
    });
    codexDebug(`[codex] stage request ${formatCompletionRequestLogFields(fields)}`);
  }

  private classifyHotkeySemanticRetryCandidate(
    request: CompletionPayload,
    suggestion: string,
  ): BlankLineHeuristicDecision {
    const trimmed = suggestion.trim();
    if (!trimmed) {
      return 'accept';
    }
    if (trimmed.includes('\n')) {
      return 'suspicious';
    }

    if (
      isBlankLineAtCursor(request.linePrefix, request.lineSuffix)
      && looksLikeBlankLineCarryoverFragment(trimmed, request.prefix)
      && !looksLikeStandaloneCodeStatement(trimmed)
    ) {
      return 'suspicious';
    }

    const linePrefix = getStructuralCursorLinePrefix(request.prefix, request.linePrefix);

    if (looksLikeOverCompletedBareReturnValue(linePrefix, trimmed)) {
      return 'suspicious';
    }

    const blankLineDecision = classifyGenericBlankLinePlaceholder(request, trimmed);
    if (blankLineDecision !== 'accept') {
      return blankLineDecision;
    }

    if (trimmed.length <= 3 && /^[)\]};,]+$/.test(trimmed)) {
      return 'accept';
    }

    const inCallContext = /[A-Za-z_][A-Za-z0-9_.]*\s*\([^()]*$/.test(linePrefix);
    const nearbyText = `${takeLastLines(request.prefix, 24)}\n${takeFirstLines(request.suffix, 12)}`;
    const nearbyIdentifiers = extractRelevantIdentifiers(nearbyText);
    const nearbyStringLiterals = extractRelevantStringLiterals(nearbyText);
    const suggestionIdentifiers = extractRelevantIdentifiers(trimmed);

    if (inCallContext && nearbyStringLiterals.length > 0) {
      if (isQuotedLiteralLike(trimmed)) {
        return 'suspicious';
      }
      if (looksLikeMissingOpeningQuoteLiteralFragment(trimmed, nearbyStringLiterals)) {
        return 'suspicious';
      }
    }

    if (nearbyIdentifiers.length > 0 && suggestionIdentifiers.length > 0) {
      const nearbySet = new Set(nearbyIdentifiers.map((value) => value.toLowerCase()));
      const hasOverlap = suggestionIdentifiers.some((value) => nearbySet.has(value.toLowerCase()));
      if (!hasOverlap) {
        return 'suspicious';
      }
    }

    return 'accept';
  }

  private shouldRunHotkeySemanticRetry(
    request: CompletionPayload,
    suggestion: string,
  ): boolean {
    return this.classifyHotkeySemanticRetryCandidate(request, suggestion) !== 'accept';
  }

  private buildHotkeySemanticRetryRequest(
    request: CompletionPayload,
    previousAttempt: string,
    forbiddenDuplicate?: string,
  ): CompletionPayload {
    return {
      ...request,
      reasoningEffort: 'low',
      instructions: buildHotkeySemanticRetryInstructions({
        existingInstructions: request.instructions,
        prefix: request.prefix,
        suffix: request.suffix,
        languageId: request.languageId,
        previousAttempt,
        forbiddenDuplicate,
      }),
      promptCacheKey: request.promptCacheKey ? `${request.promptCacheKey}:sem1` : request.promptCacheKey,
    };
  }

  private getHotkeySemanticRetryForbiddenDuplicate(
    request: CompletionPayload,
    suggestion: string,
  ): string | undefined {
    return getExactNearbyBlankLineDuplicate(
      request.linePrefix,
      request.lineSuffix,
      request.prefix,
      request.suffix,
      suggestion,
    );
  }

  private shouldDropSuspiciousSuggestionAfterEmptyRetry(
    request: CompletionPayload,
    suggestion: string,
  ): boolean {
    return Boolean(this.getHotkeySemanticRetryForbiddenDuplicate(request, suggestion));
  }


  private buildHotkeyBlankRetryRequest(
    request: CompletionPayload,
  ): CompletionPayload {
    return {
      ...request,
      reasoningEffort: 'low',
      instructions: buildHotkeyBlankRetryInstructions({
        existingInstructions: request.instructions,
        prefix: request.prefix,
        suffix: request.suffix,
        languageId: request.languageId,
      }),
      promptCacheKey: request.promptCacheKey ? `${request.promptCacheKey}:blank1` : request.promptCacheKey,
    };
  }
  private async maybeRunHotkeySemanticRetry(
    request: CompletionPayload,
    result: CompletionAttempt,
    hotkeySemanticRetry: SuggestionRequest['hotkeySemanticRetry'],
    signal: AbortSignal,
  ): Promise<CompletionAttempt> {
    if (!hotkeySemanticRetry?.enabled) {
      return result;
    }

    if (hotkeySemanticRetry.retryOnEmpty && !result.suggestion.trim()) {
      codexLog('[codex] hotkey blank retry triggered');
      const blankRetryRequest = this.buildHotkeyBlankRetryRequest(request);
      const blankRetryBudget = normalizeStageLatencyBudget({
        maxLatencyMs: hotkeySemanticRetry.maxLatencyMs,
        firstChunkMaxLatencyMs: hotkeySemanticRetry.firstChunkMaxLatencyMs,
      });
      const blankRetryResult = await this.runCompletion(
        blankRetryRequest,
        signal,
        blankRetryBudget,
        'hotkey_semantic_retry',
      );
      if (blankRetryResult.suggestion.trim()) {
        const blankRetryDecision = this.classifyHotkeySemanticRetryCandidate(
          request,
          blankRetryResult.suggestion,
        );
        if (blankRetryDecision === 'accept') {
          codexLog('[codex] hotkey blank retry used');
          return blankRetryResult;
        }
        codexLog('[codex] hotkey blank retry produced suspicious output; running semantic retry');
        const retryRequest = this.buildHotkeySemanticRetryRequest(
          request,
          blankRetryResult.suggestion,
          this.getHotkeySemanticRetryForbiddenDuplicate(request, blankRetryResult.suggestion),
        );
        const retryResult = await this.runCompletion(
          retryRequest,
          signal,
          blankRetryBudget,
          'hotkey_semantic_retry',
        );
        if (retryResult.suggestion.trim()) {
          const retryDecision = this.classifyHotkeySemanticRetryCandidate(request, retryResult.suggestion);
          if (retryDecision === 'reject') {
            if (blankRetryDecision === 'suspicious') {
              codexLog('[codex] hotkey semantic retry produced a hard placeholder after blank retry; keeping previous suspicious suggestion');
              return blankRetryResult;
            }
            codexLog('[codex] hotkey semantic retry repeated a hard blank-line placeholder after blank retry; dropping suggestion');
            return toEmptyAttempt(blankRetryResult);
          }
          codexLog('[codex] hotkey semantic retry used');
          return retryResult;
        }
        if (blankRetryDecision === 'suspicious') {
          if (this.shouldDropSuspiciousSuggestionAfterEmptyRetry(request, blankRetryResult.suggestion)) {
            codexLog('[codex] hotkey semantic retry returned empty after blank retry duplicate; dropping suspicious suggestion');
            return toEmptyAttempt(blankRetryResult);
          }
          codexLog('[codex] hotkey semantic retry returned empty after blank retry; keeping previous suspicious suggestion');
          return blankRetryResult;
        }
        codexLog('[codex] hotkey semantic retry returned empty after blank retry; dropping hard placeholder suggestion');
        return toEmptyAttempt(blankRetryResult);
      }
      codexLog('[codex] hotkey blank retry returned empty; keeping empty first suggestion');
      return result;
    }
    const resultDecision = this.classifyHotkeySemanticRetryCandidate(request, result.suggestion);
    if (resultDecision === 'accept') {
      return result;
    }
    codexLog('[codex] hotkey semantic retry triggered');
    const retryRequest = this.buildHotkeySemanticRetryRequest(
      request,
      result.suggestion,
      this.getHotkeySemanticRetryForbiddenDuplicate(request, result.suggestion),
    );
    const semanticRetryBudget = normalizeStageLatencyBudget({
      maxLatencyMs: hotkeySemanticRetry.maxLatencyMs,
      firstChunkMaxLatencyMs: hotkeySemanticRetry.firstChunkMaxLatencyMs,
    });
    const retryResult = await this.runCompletion(
      retryRequest,
      signal,
      semanticRetryBudget,
      'hotkey_semantic_retry',
    );
    if (retryResult.suggestion.trim()) {
      const retryDecision = this.classifyHotkeySemanticRetryCandidate(request, retryResult.suggestion);
      if (retryDecision === 'reject') {
        if (resultDecision === 'suspicious') {
          codexLog('[codex] hotkey semantic retry produced a hard placeholder; keeping previous suspicious suggestion');
          return result;
        }
        codexLog('[codex] hotkey semantic retry repeated a hard blank-line placeholder; dropping suggestion');
        return toEmptyAttempt(result);
      }
      codexLog('[codex] hotkey semantic retry used');
      return retryResult;
    }
    if (resultDecision === 'suspicious') {
      if (this.shouldDropSuspiciousSuggestionAfterEmptyRetry(request, result.suggestion)) {
        codexLog('[codex] hotkey semantic retry returned empty for duplicate blank-line suggestion; dropping suspicious suggestion');
        return toEmptyAttempt(result);
      }
      codexLog('[codex] hotkey semantic retry returned empty; keeping previous suspicious suggestion');
      return result;
    }
    codexLog('[codex] hotkey semantic retry returned empty; dropping hard placeholder suggestion');
    return toEmptyAttempt(result);
  }
}

function isQuotedLiteralLike(value: string): boolean {
  return /^["'`][\s\S]*["'`](?:\)|;)?$/.test(value);
}

function looksLikeMissingOpeningQuoteLiteralFragment(
  value: string,
  nearbyStringLiterals: string[],
): boolean {
  if (!value || /^["'`]/.test(value)) {
    return false;
  }

  return nearbyStringLiterals.some((literal) => {
    if (!literal || !value.startsWith(literal)) {
      return false;
    }

    const remainder = value.slice(literal.length);
    return /^["'`][)\]};,]+$/.test(remainder);
  });
}

function looksLikeOverCompletedBareReturnValue(linePrefix: string, suggestion: string): boolean {
  if (!/^\s*return\s*$/.test(linePrefix)) {
    return false;
  }

  return /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\]|\.[A-Za-z_][A-Za-z0-9_]*|\([^()]*\))+$/.test(
    suggestion,
  );
}

function classifyGenericBlankLinePlaceholder(
  request: CompletionPayload,
  suggestion: string,
): BlankLineHeuristicDecision {
  return classifyGenericBlankLineSuggestion(
    request.linePrefix,
    request.lineSuffix,
    request.prefix,
    request.suffix,
    suggestion,
  );
}

function toEmptyAttempt(result: CompletionAttempt): CompletionAttempt {
  return {
    ...result,
    suggestion: '',
  };
}
