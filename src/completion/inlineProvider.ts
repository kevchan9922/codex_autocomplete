import * as vscode from 'vscode';
import { AIProvider } from '../api/aiProvider';
import {
  buildCompletionContext,
  ContextBuilderConfig,
  DEFAULT_CONTEXT_CONFIG,
} from './contextBuilder';
import { CancellationManager } from './cancellation';
import { waitForDebounce } from './debounce';
import { CompletionMetrics } from '../performance/metrics';
import { RecencyContextStore } from './contextEnrichment';
import { isRequestCancelled } from './abortUtils';
import { buildPromptCacheKey } from './promptCacheKey';
import { InlineTelemetry } from './inlineTelemetry';
import { codexDebug, codexLog } from '../logging/codexLogger';
import {
  CompletionPipeline,
} from './completionPipeline';
import { InlineTriggerGate } from './triggerGate';
import { buildStageRequests } from './stageRequestFactory';
import { buildLatencyBudget } from './latencyBudget';
import { InlineUiController } from './inlineUiController';
import { postProcessGhostTextSuggestion } from './ghostTextPostProcessor';
import { isBlankLineAtCursor } from './blankLineHeuristics';
import { isBlankLineStructuralContinuation } from './blankLineContinuation';
import {
  buildCompletionRequestLogFields,
  formatCompletionRequestLogFields,
} from './requestDiagnostics';
import {
  INLINE_PROVIDER_INTERNAL_DEFAULTS,
  WORKSPACE_SETTING_DEFAULTS,
} from '../configDefaults';

export interface InlineProviderConfig {
  triggerMode: 'automatic' | 'hotkey';
  completionConstraintLines?: readonly string[];
  debounceMs: number;
  maxLatencyMs: number;
  firstChunkMaxLatencyMs: number;
  fastStageMaxLatencyMs: number;
  fastStagePrefixLines: number;
  fastStageSuffixLines: number;
  context: ContextBuilderConfig;
  maxOutputTokens?: number;
  serviceTier?: string;
  promptCacheKey?: string;
  promptCacheRetention?: string;
  acceptanceLogCommandId?: string;
  hotkeySemanticRetryEnabled: boolean;
  hotkeySemanticRetryMaxLatencyMs: number;
  hotkeySemanticRetryFirstChunkMaxLatencyMs: number;
}

const DEFAULT_INLINE_CONFIG: InlineProviderConfig = {
  triggerMode: WORKSPACE_SETTING_DEFAULTS.triggerMode,
  completionConstraintLines: WORKSPACE_SETTING_DEFAULTS.completionConstraintLines,
  debounceMs: WORKSPACE_SETTING_DEFAULTS.debounceMs,
  maxLatencyMs: WORKSPACE_SETTING_DEFAULTS.maxLatencyMs,
  firstChunkMaxLatencyMs: WORKSPACE_SETTING_DEFAULTS.firstChunkMaxLatencyMs,
  fastStageMaxLatencyMs: INLINE_PROVIDER_INTERNAL_DEFAULTS.fastStageMaxLatencyMs,
  fastStagePrefixLines: INLINE_PROVIDER_INTERNAL_DEFAULTS.fastStagePrefixLines,
  fastStageSuffixLines: INLINE_PROVIDER_INTERNAL_DEFAULTS.fastStageSuffixLines,
  context: DEFAULT_CONTEXT_CONFIG,
  hotkeySemanticRetryEnabled: INLINE_PROVIDER_INTERNAL_DEFAULTS.hotkeySemanticRetryEnabled,
  hotkeySemanticRetryMaxLatencyMs: INLINE_PROVIDER_INTERNAL_DEFAULTS.hotkeySemanticRetryMaxLatencyMs,
  hotkeySemanticRetryFirstChunkMaxLatencyMs:
    INLINE_PROVIDER_INTERNAL_DEFAULTS.hotkeySemanticRetryFirstChunkMaxLatencyMs,
};

const HOTKEY_FAST_STAGE_ADAPTIVE_WINDOW_SIZE = 12;
const HOTKEY_FAST_STAGE_ADAPTIVE_MIN_SAMPLES = 6;
const HOTKEY_FAST_STAGE_ADAPTIVE_FALLBACK_RATE = 0.67;
const HOTKEY_FAST_STAGE_SKIP_BURST_REQUESTS = 4;

export class InlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  private readonly cancellationManager: CancellationManager;
  private readonly metrics: CompletionMetrics;
  private readonly config: InlineProviderConfig;
  private readonly recencyStore: RecencyContextStore;
  private readonly telemetry = new InlineTelemetry();
  private readonly triggerGate: InlineTriggerGate;
  private readonly completionPipeline: CompletionPipeline;
  private readonly uiController = new InlineUiController();
  private readonly manualTriggerBudgetByEditor = new Map<string, number>();
  private readonly hotkeyFastStageOutcomes: Array<'hit' | 'fallback'> = [];
  private hotkeyFastStageSkipBudget = 0;
  private requestSequence = 0;

  constructor(
    provider: AIProvider,
    cancellationManager = new CancellationManager(),
    config: Partial<InlineProviderConfig> = {},
    metrics = new CompletionMetrics(),
    recencyStore = new RecencyContextStore(),
  ) {
    this.cancellationManager = cancellationManager;
    this.metrics = metrics;
    this.recencyStore = recencyStore;
    this.config = {
      triggerMode: config.triggerMode ?? DEFAULT_INLINE_CONFIG.triggerMode,
      completionConstraintLines:
        config.completionConstraintLines ?? DEFAULT_INLINE_CONFIG.completionConstraintLines,
      debounceMs: config.debounceMs ?? DEFAULT_INLINE_CONFIG.debounceMs,
      maxLatencyMs: config.maxLatencyMs ?? DEFAULT_INLINE_CONFIG.maxLatencyMs,
      firstChunkMaxLatencyMs:
        config.firstChunkMaxLatencyMs ?? DEFAULT_INLINE_CONFIG.firstChunkMaxLatencyMs,
      fastStageMaxLatencyMs:
        config.fastStageMaxLatencyMs ?? DEFAULT_INLINE_CONFIG.fastStageMaxLatencyMs,
      fastStagePrefixLines:
        config.fastStagePrefixLines ?? DEFAULT_INLINE_CONFIG.fastStagePrefixLines,
      fastStageSuffixLines:
        config.fastStageSuffixLines ?? DEFAULT_INLINE_CONFIG.fastStageSuffixLines,
      context: config.context ?? DEFAULT_INLINE_CONFIG.context,
      maxOutputTokens: config.maxOutputTokens,
      serviceTier: config.serviceTier,
      promptCacheKey: config.promptCacheKey,
      promptCacheRetention: config.promptCacheRetention,
      acceptanceLogCommandId: config.acceptanceLogCommandId,
      hotkeySemanticRetryEnabled:
        config.hotkeySemanticRetryEnabled ?? DEFAULT_INLINE_CONFIG.hotkeySemanticRetryEnabled,
      hotkeySemanticRetryMaxLatencyMs:
        config.hotkeySemanticRetryMaxLatencyMs ?? DEFAULT_INLINE_CONFIG.hotkeySemanticRetryMaxLatencyMs,
      hotkeySemanticRetryFirstChunkMaxLatencyMs:
        config.hotkeySemanticRetryFirstChunkMaxLatencyMs
        ?? DEFAULT_INLINE_CONFIG.hotkeySemanticRetryFirstChunkMaxLatencyMs,
    };
    this.triggerGate = new InlineTriggerGate(this.config.triggerMode);
    this.completionPipeline = new CompletionPipeline(
      provider,
      (valueMs) => this.recordFirstChunkLatency(valueMs),
      (event) => this.recordStageEvent(event),
    );
  }

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[]> {
    const requestId = this.nextRequestId();
    const editorKey = this.getEditorKey(document);
    const isInvokeTrigger =
      context.triggerKind === vscode.InlineCompletionTriggerKind.Invoke;
    if (
      this.config.triggerMode === 'hotkey'
      && isInvokeTrigger
      && this.consumeManualTrigger(editorKey)
    ) {
      this.triggerGate.markManualTriggerWindow();
    }

    const triggerResult = this.triggerGate.evaluateRequest(context, token);
    if (!triggerResult.allowed) {
      return [];
    }
    if (
      this.config.triggerMode === 'hotkey'
      && triggerResult.explicitHotkeyTrigger
      && !isInvokeTrigger
    ) {
      // Automatic fallback trigger consumed this hotkey; clear burst budget to avoid a delayed duplicate invoke.
      this.clearManualTrigger(editorKey);
    }

    let cancellationHandle: ReturnType<CancellationManager['begin']> | undefined;

    try {
      if (this.config.triggerMode !== 'hotkey') {
        cancellationHandle = this.cancellationManager.begin(editorKey, {
          supersedeReason: 'cancelled_by_new_request',
        });
        await waitForDebounce(this.config.debounceMs, cancellationHandle.signal);
        if (token.isCancellationRequested || !cancellationHandle.isLatest()) {
          return [];
        }
      }

      const snapshot = {
        text: document.getText(),
        languageId: document.languageId,
        filePath: document.uri.fsPath,
      };

      const contextResult = buildCompletionContext(
        snapshot,
        { line: position.line, character: position.character },
        this.config.context,
      );

      if (contextResult.truncatedForFileSize) {
        codexLog(
          `[codex] context built from oversized file lineCount=${contextResult.lineCount} maxFileLines=${this.config.context.maxFileLines}`,
        );
      }

      if (!cancellationHandle) {
        cancellationHandle = this.cancellationManager.begin(editorKey, {
          supersedeReason: 'cancelled_by_new_request',
        });
      }

      if (token.isCancellationRequested || !cancellationHandle.isLatest()) {
        return [];
      }

      this.recencyStore.recordContext({
        filePath: snapshot.filePath,
        languageId: snapshot.languageId,
        prefix: contextResult.context.prefix,
        suffix: contextResult.context.suffix,
        selection: contextResult.context.selection,
      });

      const metricsHandle = this.metrics.beginRequest();
      const requestStart = Date.now();

      try {
        if (token.isCancellationRequested || !cancellationHandle.isLatest()) {
          metricsHandle.endCancelled();
          return [];
        }
        const dynamicCacheKey = buildPromptCacheKey(
          this.config.promptCacheKey,
          contextResult.context,
        );

        const { fastRequest, fullRequestFactory } = buildStageRequests({
          context: contextResult.context,
          dynamicCacheKey,
            config: {
              fastStagePrefixLines: this.config.fastStagePrefixLines,
              fastStageSuffixLines: this.config.fastStageSuffixLines,
              completionConstraintLines: this.config.completionConstraintLines,
              maxOutputTokens: this.config.maxOutputTokens,
            serviceTier: this.config.serviceTier,
            promptCacheRetention: this.config.promptCacheRetention,
          },
          document,
          position,
          snapshotText: snapshot.text,
          recencyStore: this.recencyStore,
          explicitHotkeyTrigger: triggerResult.explicitHotkeyTrigger,
        });
        codexDebug(
          `[codex] inline request ${formatCompletionRequestLogFields(
            buildCompletionRequestLogFields(fastRequest, {
              source: 'inline_provider',
              stage: 'fast',
              editorKey,
              requestId,
              contextHash: contextResult.context.hash,
            }),
          )}`,
        );

        const latencyBudget = buildLatencyBudget(
          {
            maxLatencyMs: this.config.maxLatencyMs,
            firstChunkMaxLatencyMs: this.config.firstChunkMaxLatencyMs,
            fastStageMaxLatencyMs: this.config.fastStageMaxLatencyMs,
          },
        );
        const skipFastStage = this.shouldSkipHotkeyFastStage(triggerResult.explicitHotkeyTrigger);
        if (skipFastStage) {
          codexLog('[codex] hotkey adaptive mode: skipping fast-stage for this request');
        }
        const suggestionResult = await this.completionPipeline.getSuggestion({
          editorKey,
          contextHash: contextResult.context.hash,
          fastRequest,
          fullRequestFactory,
          latencyBudget,
          // Run fast-stage first for hotkey requests, unless adaptive skip is active.
          skipFastStage,
          hotkeySemanticRetry: {
            enabled: this.config.hotkeySemanticRetryEnabled && triggerResult.explicitHotkeyTrigger,
            retryOnEmpty: true,
            maxLatencyMs: this.config.hotkeySemanticRetryMaxLatencyMs,
            firstChunkMaxLatencyMs: this.config.hotkeySemanticRetryFirstChunkMaxLatencyMs,
          },
          signal: cancellationHandle.signal,
        });

        let activeSuggestionResult = suggestionResult;
        let processedSuggestion = postProcessGhostTextSuggestion({
          suggestion: activeSuggestionResult.suggestion,
          timedOutBeforeFirstChunk: activeSuggestionResult.timedOutBeforeFirstChunk,
          prefix: contextResult.context.prefix,
          suffix: contextResult.context.suffix,
          filePath: contextResult.context.filePath,
          linePrefix: contextResult.context.linePrefix,
          lineSuffix: contextResult.context.lineSuffix,
          languageId: contextResult.context.languageId,
          beforeLines: contextResult.context.beforeLines,
        });
        if (
          processedSuggestion.droppedDuplicateLaterSuffixLine
          && triggerResult.explicitHotkeyTrigger
          && this.config.hotkeySemanticRetryEnabled
          && processedSuggestion.droppedDuplicateLaterSuffixText?.trim()
        ) {
          codexLog(
            `[codex] duplicate-later-suffix retry triggered duplicate=${JSON.stringify(processedSuggestion.droppedDuplicateLaterSuffixText)}`,
          );
          const duplicateRetryRequest = await fullRequestFactory();
          const duplicateRetryResult = await this.completionPipeline.runHotkeyDuplicateRetry({
            request: duplicateRetryRequest,
            previousAttempt: activeSuggestionResult.suggestion,
            forbiddenDuplicate: processedSuggestion.droppedDuplicateLaterSuffixText,
            maxLatencyMs: this.config.hotkeySemanticRetryMaxLatencyMs,
            firstChunkMaxLatencyMs: this.config.hotkeySemanticRetryFirstChunkMaxLatencyMs,
            signal: cancellationHandle.signal,
          });
          activeSuggestionResult = {
            suggestion: duplicateRetryResult.suggestion,
            completedContextHashHit: false,
            timedOutBeforeFirstChunk: duplicateRetryResult.timedOutBeforeFirstChunk,
            timedOut: duplicateRetryResult.timedOut,
          };
          processedSuggestion = postProcessGhostTextSuggestion({
            suggestion: activeSuggestionResult.suggestion,
            timedOutBeforeFirstChunk: activeSuggestionResult.timedOutBeforeFirstChunk,
            prefix: contextResult.context.prefix,
            suffix: contextResult.context.suffix,
            filePath: contextResult.context.filePath,
            linePrefix: contextResult.context.linePrefix,
            lineSuffix: contextResult.context.lineSuffix,
            languageId: contextResult.context.languageId,
            beforeLines: contextResult.context.beforeLines,
          });
          if (processedSuggestion.text.trim()) {
            codexLog('[codex] duplicate-later-suffix retry used');
          } else {
            codexLog('[codex] duplicate-later-suffix retry returned empty after duplicate drop');
          }
        }
        if (processedSuggestion.repairedFrom !== undefined) {
          const repairReasonSuffix = processedSuggestion.repairReasons?.length
            ? ` reasons=${JSON.stringify(processedSuggestion.repairReasons)}`
            : '';
          codexLog(
            `[codex] repaired suggestion ${JSON.stringify(processedSuggestion.repairedFrom)} -> ${JSON.stringify(processedSuggestion.text)}${repairReasonSuffix}`,
          );
        }
        codexLog(
          `[codex] inline suggestion text ${JSON.stringify(processedSuggestion.text)}`,
        );
        if (processedSuggestion.timeoutFallback) {
          codexLog(
            `[codex] inline timeout fallback used ${JSON.stringify(processedSuggestion.timeoutFallback)}`,
          );
        }
        if (processedSuggestion.droppedDuplicateLaterSuffixLine) {
          codexLog('[codex] dropped suggestion that duplicated the first meaningful later suffix line');
        }
        const normalizedSuggestion = { text: processedSuggestion.text };

        if (!normalizedSuggestion.text.trim()) {
          codexLog(
            `[codex] inline suggestion resolved empty raw=${JSON.stringify(activeSuggestionResult.suggestion)} repaired=${JSON.stringify(processedSuggestion.text)} reasons=${JSON.stringify(processedSuggestion.repairReasons ?? [])} timedOutBeforeFirstChunk=${activeSuggestionResult.timedOutBeforeFirstChunk} timedOut=${activeSuggestionResult.timedOut}`,
          );
          this.completionPipeline.clearSuggestionState(editorKey);
          let scheduledEmptyHotkeyRetrigger = false;
          if (!activeSuggestionResult.completedContextHashHit) {
            if (triggerResult.explicitHotkeyTrigger) {
              scheduledEmptyHotkeyRetrigger = this.shouldScheduleEmptyHotkeyRetrigger(
                contextResult.context.languageId,
                contextResult.context.prefix,
                contextResult.context.linePrefix,
                contextResult.context.lineSuffix,
              )
                ? this.scheduleEmptyHotkeyRetrigger(
                  editorKey,
                  contextResult.context.hash,
                )
                : false;
            }
            if (!scheduledEmptyHotkeyRetrigger && activeSuggestionResult.timedOutBeforeFirstChunk) {
              this.uiController.notifyFirstChunkTimeout(latencyBudget.firstChunkMaxLatencyMs);
            } else if (!scheduledEmptyHotkeyRetrigger && activeSuggestionResult.timedOut) {
              this.uiController.notifyPostChunkTimeout();
            } else if (!scheduledEmptyHotkeyRetrigger && !activeSuggestionResult.suggestion.trim()) {
              this.uiController.notifyEmptyModelResponse();
            }
          }
          codexLog('[codex] inline suggestion empty, dropping');
          this.recordEmptyResult();
          metricsHandle.endCancelled();
          return [];
        }

        if (token.isCancellationRequested) {
          codexLog('[codex] vscode token cancelled before suggestion returned');
          if (this.uiController.shouldRetriggerInline(editorKey, contextResult.context.hash)) {
            this.markManualTriggerWindow();
            this.markManualTrigger(editorKey, 1);
            this.uiController.clearHotkeyTriggered('superseded');
            void vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
            codexLog('[codex] retriggered inline suggestion after cancellation');
          }
          metricsHandle.endCancelled();
          return [];
        }

        if (!cancellationHandle.isLatest()) {
          codexLog('[codex] inline suggestion dropped: stale request');
          metricsHandle.endCancelled();
          return [];
        }

        if (contextResult.context.suffix.startsWith(normalizedSuggestion.text)) {
          codexLog('[codex] inline suggestion matches existing suffix');
        }

        const suffixOverlap = contextResult.context.suffix.startsWith(normalizedSuggestion.text);
        const selectedCompletionInfo = context.selectedCompletionInfo;
        const selectedCompletionText = selectedCompletionInfo?.text ?? '';
        const selectedCompletionPrefixMatch =
          !selectedCompletionInfo
          || normalizedSuggestion.text.startsWith(selectedCompletionText);
        codexDebug(
          `[codex] ghost text diagnostics requestId=${requestId} contextHash=${contextResult.context.hash} selectedCompletionInfo=${Boolean(selectedCompletionInfo)} selectedTextLength=${selectedCompletionText.length} selectedPrefixMatch=${selectedCompletionPrefixMatch} suffixOverlap=${suffixOverlap}`,
        );

        const elapsedMs = Date.now() - requestStart;
        codexLog(
          `[codex] inline suggestion length=${normalizedSuggestion.text.length} in ${elapsedMs}ms`,
        );
        this.completionPipeline.recordAcceptedSuggestion(
          editorKey,
          contextResult.context.hash,
          normalizedSuggestion.text,
        );
        metricsHandle.endSuccess(normalizedSuggestion.text);
        codexLog(
          `[codex] ghost text candidate returned requestId=${requestId} editor=${editorKey} line=${position.line} char=${position.character} len=${normalizedSuggestion.text.length}`,
        );
        this.uiController.clearHotkeyTriggered();

        const item: vscode.InlineCompletionItem = { insertText: normalizedSuggestion.text };
        const insertRange = this.buildCursorInlineRange(position);
        if (insertRange) {
          item.range = insertRange;
          codexDebug(
            `[codex] ghost text insert range anchored requestId=${requestId} line=${position.line} char=${position.character}`,
          );
        } else {
          codexDebug(
            `[codex] ghost text insert range unavailable requestId=${requestId}`,
          );
        }
        if (this.config.acceptanceLogCommandId) {
          item.command = {
            title: 'Codex Autocomplete: Inline Suggestion Accepted',
            command: this.config.acceptanceLogCommandId,
            arguments: [{
              requestId,
              editorKey,
              line: position.line,
              character: position.character,
              suggestionLength: normalizedSuggestion.text.length,
              suggestionPreview: this.buildSuggestionPreview(normalizedSuggestion.text),
            }],
          };
        }
        return [item];
      } catch (err) {
        if (isRequestCancelled(err)) {
          const elapsedMs = Date.now() - requestStart;
          const cancellationReason = cancellationHandle.getAbortReason()
            ?? (token.isCancellationRequested ? 'cancelled_by_vscode_token' : 'cancelled_external');
          codexLog(
            `[codex] inline request cancelled reason=${cancellationReason} after ${elapsedMs}ms`,
          );
          metricsHandle.endCancelled();
          return [];
        }

        const elapsedMs = Date.now() - requestStart;
        codexLog(`[codex] inline request error after ${elapsedMs}ms`);
        if (err instanceof Error) {
          codexLog(`[codex] inline request error detail name=${err.name} message=${err.message}`);
          if (err.stack) {
            codexDebug(`[codex] inline request error stack ${err.stack}`);
          }
        } else {
          codexLog(`[codex] inline request error detail ${JSON.stringify(err)}`);
        }
        codexLog('[codex] inline request error');
        metricsHandle.endError();
        return [];
      }
    } finally {
      cancellationHandle?.release();
    }
  }

  dispose(): void {
    this.cancellationManager.cancelAll();
    this.completionPipeline.dispose();
    this.uiController.dispose();
    this.manualTriggerBudgetByEditor.clear();
  }

  markManualTriggerWindow(durationMs = 1200): void {
    this.triggerGate.markManualTriggerWindow(durationMs);
  }

  markManualTrigger(editorKey: string, burstCount = 3): void {
    this.manualTriggerBudgetByEditor.set(editorKey, Math.max(1, Math.floor(burstCount)));
  }

  markManualTriggerForDocument(document: vscode.TextDocument, burstCount = 3): void {
    this.markManualTrigger(this.getEditorKey(document), burstCount);
  }

  getDebugMetrics(): {
    totals: ReturnType<CompletionMetrics['getSnapshot']>;
    emptyResultRate: number;
    firstChunkP50Ms: number;
    firstChunkP95Ms: number;
    fastStageHitRate: number;
    fastStageFallbackRate: number;
    fastStageP50Ms: number;
    fastStageP95Ms: number;
    fullStageRuns: number;
    fullStageP50Ms: number;
    fullStageP95Ms: number;
  } {
    return this.telemetry.buildDebugSnapshot(this.metrics);
  }

  private recordFirstChunkLatency(valueMs: number): void {
    this.telemetry.recordFirstChunkLatency(valueMs);
  }

  private recordEmptyResult(): void {
    this.telemetry.recordEmptyResult();
  }

  private recordStageEvent(event: Parameters<InlineTelemetry['recordStageEvent']>[0]): void {
    this.telemetry.recordStageEvent(event);
    if (event.stage !== 'fast') {
      return;
    }
    if (event.outcome === 'hit') {
      this.recordHotkeyFastStageOutcome('hit');
      return;
    }
    if (event.outcome === 'empty' || event.outcome === 'error') {
      this.recordHotkeyFastStageOutcome('fallback');
    }
  }

  private nextRequestId(): number {
    this.requestSequence += 1;
    return this.requestSequence;
  }

  private buildSuggestionPreview(value: string): string {
    const normalized = value.replace(/\s+/g, ' ').trim();
    if (normalized.length <= 120) {
      return normalized;
    }
    return `${normalized.slice(0, 120)}...`;
  }

  private getEditorKey(document: vscode.TextDocument): string {
    return document.uri.fsPath || document.uri.toString();
  }

  private consumeManualTrigger(editorKey: string): boolean {
    const budget = this.manualTriggerBudgetByEditor.get(editorKey);
    if (!budget || budget <= 0) {
      return false;
    }
    if (budget === 1) {
      this.manualTriggerBudgetByEditor.delete(editorKey);
    } else {
      this.manualTriggerBudgetByEditor.set(editorKey, budget - 1);
    }
    return true;
  }

  private clearManualTrigger(editorKey: string): void {
    this.manualTriggerBudgetByEditor.delete(editorKey);
  }

  private scheduleEmptyHotkeyRetrigger(editorKey: string, contextHash: string): boolean {
    if (!this.uiController.shouldRetriggerInline(editorKey, contextHash)) {
      return false;
    }
    this.markManualTriggerWindow();
    this.markManualTrigger(editorKey, 1);
    this.uiController.notifyHotkeyRetrying();
    void vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
    codexLog('[codex] retriggered inline suggestion after empty hotkey result');
    return true;
  }

  private shouldScheduleEmptyHotkeyRetrigger(
    languageId: string,
    prefix: string,
    linePrefix: string,
    lineSuffix: string,
  ): boolean {
    if (languageId === 'markdown' || languageId === 'plaintext') {
      return true;
    }

    return !(
      isBlankLineAtCursor(linePrefix, lineSuffix)
      && !isBlankLineStructuralContinuation(prefix, linePrefix)
    );
  }

  private buildCursorInlineRange(position: vscode.Position): vscode.Range | undefined {
    const vscodeWithRange = vscode as unknown as {
      Range?: new (start: vscode.Position, end: vscode.Position) => vscode.Range;
    };
    if (typeof vscodeWithRange.Range !== 'function') {
      return undefined;
    }
    return new vscodeWithRange.Range(position, position);
  }

  private shouldSkipHotkeyFastStage(explicitHotkeyTrigger: boolean): boolean {
    if (!explicitHotkeyTrigger || this.config.triggerMode !== 'hotkey') {
      return false;
    }

    if (this.hotkeyFastStageSkipBudget > 0) {
      this.hotkeyFastStageSkipBudget -= 1;
      codexDebug(
        `[codex] hotkey adaptive fast-stage skip active remaining=${this.hotkeyFastStageSkipBudget}`,
      );
      return true;
    }

    const sampleCount = this.hotkeyFastStageOutcomes.length;
    if (sampleCount < HOTKEY_FAST_STAGE_ADAPTIVE_MIN_SAMPLES) {
      return false;
    }

    const fallbackCount = this.hotkeyFastStageOutcomes
      .reduce((total, outcome) => total + (outcome === 'fallback' ? 1 : 0), 0);
    const fallbackRate = fallbackCount / sampleCount;
    if (fallbackRate < HOTKEY_FAST_STAGE_ADAPTIVE_FALLBACK_RATE) {
      return false;
    }

    this.hotkeyFastStageSkipBudget = HOTKEY_FAST_STAGE_SKIP_BURST_REQUESTS - 1;
    codexLog(
      `[codex] hotkey adaptive fast-stage skip enabled samples=${sampleCount} fallbackRate=${Math.round(fallbackRate * 100)}% requests=${HOTKEY_FAST_STAGE_SKIP_BURST_REQUESTS}`,
    );
    return true;
  }

  private recordHotkeyFastStageOutcome(outcome: 'hit' | 'fallback'): void {
    if (this.config.triggerMode !== 'hotkey') {
      return;
    }

    this.hotkeyFastStageOutcomes.push(outcome);
    if (this.hotkeyFastStageOutcomes.length > HOTKEY_FAST_STAGE_ADAPTIVE_WINDOW_SIZE) {
      this.hotkeyFastStageOutcomes.shift();
    }
  }
}
