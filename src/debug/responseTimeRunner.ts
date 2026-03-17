import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { AIProvider, CompletionRequestTelemetry } from '../api/aiProvider';
import { CompletionPayload } from '../completion/completionPipeline';
import { buildInlineRequestInstructions } from '../completion/completionInstructions';
import { postProcessGhostTextSuggestion } from '../completion/ghostTextPostProcessor';
import {
  buildCompletionRequestLogFields,
  formatCompletionRequestLogFields,
  normalizeInlineRequestContext,
  NormalizedInlineRequestContext,
} from '../completion/requestDiagnostics';
import { codexLog } from '../logging/codexLogger';
import { runHotkeyGhostTextFlow } from './hotkeyGhostTextFlow';
import {
  INLINE_PROVIDER_INTERNAL_DEFAULTS,
  WORKSPACE_SETTING_DEFAULTS,
} from '../configDefaults';

interface ResponseTimeTestRow {
  test: string;
  targetOutput: string;
  filePath?: string;
  languageId?: string;
  cursorAfter?: string;
  cursorAfterOccurrence?: number;
  cursorLine?: number;
  cursorChar?: number;
  lockQuotes?: boolean;
  lockArgForm?: boolean;
  lockObjectKeyOrder?: boolean;
  lockDelimiterSpacing?: boolean;
  rowTags?: string[];
}

type ResponseTimeRequestContext = NormalizedInlineRequestContext;

type ResponseTimeBenchmarkMode = 'automatic_direct' | 'hotkey_inline';

interface ExecutedRequestSummary {
  request: {
    prefix: string;
    suffix: string;
    languageId: string;
    filePath: string;
    context?: string;
    instructions: string;
  };
  responseText: string;
  firstChunkMs?: number;
  totalDurationMs: number;
  hotkeyPressToAcceptMs?: number;
  status: 'success' | 'empty' | 'error';
  requestMetrics: {
    scenarioChars: number;
    constraintChars: number;
    beforeLinesCount: number;
    rowTags: string[];
  };
  providerTelemetry?: CompletionRequestTelemetry;
  loggingImpact?: {
    infoEmitted: number;
    infoSuppressed: number;
    infoEmitMs: number;
    debugEmitted: number;
    debugSuppressed: number;
    debugEmitMs: number;
  };
}

interface ResponseTimeRunnerOptions {
  workspaceFolder: string;
  output: vscode.OutputChannel;
  provider: AIProvider;
  languageId: string;
  filePath: string;
  model: string;
  endpoint: string;
  instructions: string;
  maxOutputTokens?: number;
  serviceTier?: string;
  promptCacheKey?: string;
  promptCacheRetention?: string;
  benchmarkMode?: ResponseTimeBenchmarkMode;
  hotkeyMaxLatencyMs?: number;
  hotkeyFirstChunkMaxLatencyMs?: number;
  hotkeyFastStageMaxLatencyMs?: number;
  hotkeyFastStagePrefixLines?: number;
  hotkeyFastStageSuffixLines?: number;
  hotkeySemanticRetryEnabled?: boolean;
  hotkeySemanticRetryMaxLatencyMs?: number;
  hotkeySemanticRetryFirstChunkMaxLatencyMs?: number;
  inputFilePath?: string;
  buildContext: () => string | ResponseTimeRequestContext | Promise<string | ResponseTimeRequestContext>;
  buildContextForRow?: (row: ResponseTimeTestRow) => string | ResponseTimeRequestContext | Promise<string | ResponseTimeRequestContext>;
  timestamp?: Date;
}

const INSTRUMENTATION_COLUMN_NAMES = [
  'prefix_chars',
  'suffix_chars',
  'extra_context_chars',
  'scenario_chars',
  'constraint_chars',
  'before_lines_count',
  'headers_latency_ms',
  'first_raw_chunk_ms',
  'first_payload_ms',
  'first_text_ms',
  'stream_duration_ms',
  'server_processing_ms',
  'request_id',
  'row_tags',
  'pre_attempt_ms',
  'hotkey_press_to_accept_ms',
] as const;
const INSTRUMENTATION_COLUMNS = INSTRUMENTATION_COLUMN_NAMES.join(',');
const RUN_OUTPUT_HEADER =
  `test,target_output,first_chunk_ms,total_duration_ms,status,match_target_output,context_char_count,instructions_char_count,input_chars_est,input_tokens_est,output,benchmark_mode,${INSTRUMENTATION_COLUMNS}`;
const LEGACY_HISTORY_HEADER =
  'run_id,run_started_at,test,target_output,first_chunk_ms,total_duration_ms,status,match_target_output,output_length,language_id,file_path,model,endpoint';
const HISTORY_HEADER_V1 =
  `${LEGACY_HISTORY_HEADER},context_char_count,instructions_char_count,input_chars_est,input_tokens_est`;
const HISTORY_HEADER_V2 =
  `${HISTORY_HEADER_V1},benchmark_mode`;
const HISTORY_HEADER =
  `${HISTORY_HEADER_V2},${INSTRUMENTATION_COLUMNS}`;
const DEFAULT_BENCHMARK_MODE: ResponseTimeBenchmarkMode = 'hotkey_inline';
const DEFAULT_HOTKEY_MAX_LATENCY_MS = WORKSPACE_SETTING_DEFAULTS.maxLatencyMs;
const DEFAULT_HOTKEY_FIRST_CHUNK_MAX_LATENCY_MS =
  WORKSPACE_SETTING_DEFAULTS.firstChunkMaxLatencyMs;
const DEFAULT_HOTKEY_FAST_STAGE_MAX_LATENCY_MS =
  INLINE_PROVIDER_INTERNAL_DEFAULTS.fastStageMaxLatencyMs;
const DEFAULT_HOTKEY_FAST_STAGE_PREFIX_LINES =
  INLINE_PROVIDER_INTERNAL_DEFAULTS.fastStagePrefixLines;
const DEFAULT_HOTKEY_FAST_STAGE_SUFFIX_LINES =
  INLINE_PROVIDER_INTERNAL_DEFAULTS.fastStageSuffixLines;
const DEFAULT_HOTKEY_SEMANTIC_RETRY_ENABLED =
  INLINE_PROVIDER_INTERNAL_DEFAULTS.hotkeySemanticRetryEnabled;
const DEFAULT_HOTKEY_SEMANTIC_RETRY_MAX_LATENCY_MS =
  INLINE_PROVIDER_INTERNAL_DEFAULTS.hotkeySemanticRetryMaxLatencyMs;
const DEFAULT_HOTKEY_SEMANTIC_RETRY_FIRST_CHUNK_MAX_LATENCY_MS =
  INLINE_PROVIDER_INTERNAL_DEFAULTS.hotkeySemanticRetryFirstChunkMaxLatencyMs;
const SCENARIO_DEPENDENT_TARGET_OUTPUT = '<scenario-dependent>';
const HISTORY_INSTRUMENTATION_COLUMN_COUNT = INSTRUMENTATION_COLUMN_NAMES.length;

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

export async function runAutocompleteResponseTimeTest(
  options: ResponseTimeRunnerOptions,
): Promise<void> {
  const runStartedAt = options.timestamp ?? new Date();
  const runId = formatTimestamp(runStartedAt);
  const artifactDir = path.join(options.workspaceFolder, 'test_artifacts');
  const inputPath = options.inputFilePath ?? path.join(
    options.workspaceFolder,
    'test_files',
    'autocomplete_test_input.json',
  );
  const runOutputPath = path.join(
    artifactDir,
    `response_time_test_output_${runId}.csv`,
  );
  const historyPath = path.join(artifactDir, 'response_time_history.csv');
  const legacyHistoryPaths = [
    path.join(options.workspaceFolder, 'test_files', 'response_time_history.csv'),
    path.join(options.workspaceFolder, 'response_time_history.csv'),
  ];

  let rows: ResponseTimeTestRow[];
  try {
    const json = await fs.readFile(inputPath, 'utf8');
    rows = parseResponseTimeInputJson(json);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    options.output.appendLine(`Failed reading input JSON (${inputPath}): ${message}`);
    return;
  }

  if (rows.length === 0) {
    options.output.appendLine(`No rows found in input JSON (${inputPath})`);
    return;
  }

  try {
    await fs.mkdir(artifactDir, { recursive: true });
    await seedHistoryFromLegacyPaths(historyPath, legacyHistoryPaths);
    await fs.writeFile(runOutputPath, `${RUN_OUTPUT_HEADER}\n`, 'utf8');
    await ensureHistoryFile(historyPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    options.output.appendLine(`Failed initializing response-time outputs: ${message}`);
    return;
  }

  let completedRows = 0;
  const runStartedAtIso = runStartedAt.toISOString();
  const benchmarkMode = normalizeBenchmarkMode(options.benchmarkMode);

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    options.output.appendLine(
      `Response-time row ${index + 1}/${rows.length} (mode=${benchmarkMode})...`,
    );

    const rowLanguageId = row.languageId ?? options.languageId;
    const rowFilePath = resolveRowFilePath(
      options.workspaceFolder,
      row.filePath ?? options.filePath,
    );
    const computedContext = await (
      options.buildContextForRow ? options.buildContextForRow(row) : options.buildContext()
    );
    const requestContext = normalizeInlineRequestContext(computedContext);
    const executionResult = benchmarkMode === 'hotkey_inline'
      ? await runHotkeyInlineBenchmark({
        provider: options.provider,
        requestContext,
        rowLanguageId,
        rowFilePath,
        rowTest: row.test,
        rowTargetOutput: row.targetOutput,
        rowTags: row.rowTags,
        lockQuotes: row.lockQuotes,
        lockArgForm: row.lockArgForm,
        lockObjectKeyOrder: row.lockObjectKeyOrder,
        lockDelimiterSpacing: row.lockDelimiterSpacing,
        baseInstructions: options.instructions,
        maxOutputTokens: options.maxOutputTokens,
        serviceTier: options.serviceTier,
        promptCacheKey: options.promptCacheKey,
        promptCacheRetention: options.promptCacheRetention,
        rowIndex: index,
        hotkeyMaxLatencyMs: options.hotkeyMaxLatencyMs ?? DEFAULT_HOTKEY_MAX_LATENCY_MS,
        hotkeyFirstChunkMaxLatencyMs:
            options.hotkeyFirstChunkMaxLatencyMs ?? DEFAULT_HOTKEY_FIRST_CHUNK_MAX_LATENCY_MS,
        hotkeyFastStageMaxLatencyMs:
            options.hotkeyFastStageMaxLatencyMs ?? DEFAULT_HOTKEY_FAST_STAGE_MAX_LATENCY_MS,
        hotkeyFastStagePrefixLines:
            options.hotkeyFastStagePrefixLines ?? DEFAULT_HOTKEY_FAST_STAGE_PREFIX_LINES,
        hotkeyFastStageSuffixLines:
            options.hotkeyFastStageSuffixLines ?? DEFAULT_HOTKEY_FAST_STAGE_SUFFIX_LINES,
        hotkeySemanticRetryEnabled:
            options.hotkeySemanticRetryEnabled ?? DEFAULT_HOTKEY_SEMANTIC_RETRY_ENABLED,
        hotkeySemanticRetryMaxLatencyMs:
            options.hotkeySemanticRetryMaxLatencyMs ?? DEFAULT_HOTKEY_SEMANTIC_RETRY_MAX_LATENCY_MS,
        hotkeySemanticRetryFirstChunkMaxLatencyMs:
            options.hotkeySemanticRetryFirstChunkMaxLatencyMs
            ?? DEFAULT_HOTKEY_SEMANTIC_RETRY_FIRST_CHUNK_MAX_LATENCY_MS,
      })
      : await runAutomaticDirectBenchmark({
        provider: options.provider,
        requestContext,
        rowLanguageId,
        rowFilePath,
        rowTest: row.test,
        rowTargetOutput: row.targetOutput,
        rowTags: row.rowTags,
        lockQuotes: row.lockQuotes,
        lockArgForm: row.lockArgForm,
        lockObjectKeyOrder: row.lockObjectKeyOrder,
        lockDelimiterSpacing: row.lockDelimiterSpacing,
        baseInstructions: options.instructions,
        maxOutputTokens: options.maxOutputTokens,
        serviceTier: options.serviceTier,
        promptCacheKey: options.promptCacheKey,
        promptCacheRetention: options.promptCacheRetention,
      });

    const requestForEstimate = executionResult.request;
    const responseText = executionResult.responseText;
    const firstChunkMs = executionResult.firstChunkMs;
    const totalDurationMs = executionResult.totalDurationMs;
    const status = executionResult.status;
    const instructionsCharCount = String(requestForEstimate.instructions.length);
    const inputCharsEstimateValue = estimateInputChars(requestForEstimate);
    const inputCharsEstimate = String(inputCharsEstimateValue);
    const inputTokensEstimate = String(estimateInputTokens(inputCharsEstimateValue));
    const firstChunkCell = firstChunkMs === undefined ? 'n/a' : String(firstChunkMs);
    const isScenarioDependent = isScenarioDependentTargetOutput(row.targetOutput);
    const matchTargetOutput = isScenarioDependent
      ? ''
      : (responseText.trim() === row.targetOutput.trim() ? 'true' : 'false');
    const prefixChars = String(requestForEstimate.prefix.length);
    const suffixChars = String(requestForEstimate.suffix.length);
    const extraContextCharsValue = requestForEstimate.context?.length ?? 0;
    const extraContextChars = String(extraContextCharsValue);
    const contextCharCount = String(extraContextCharsValue);
    const scenarioChars = String(executionResult.requestMetrics.scenarioChars);
    const constraintChars = String(executionResult.requestMetrics.constraintChars);
    const beforeLinesCount = String(executionResult.requestMetrics.beforeLinesCount);
    const rowTags = executionResult.requestMetrics.rowTags.join('|');
    const headersLatencyMs = formatOptionalMetricCell(executionResult.providerTelemetry?.headersLatencyMs);
    const firstRawChunkMs = formatOptionalMetricCell(executionResult.providerTelemetry?.firstRawChunkMs);
    const firstPayloadMs = formatOptionalMetricCell(executionResult.providerTelemetry?.firstPayloadMs);
    const firstTextMs = formatOptionalMetricCell(executionResult.providerTelemetry?.firstTextMs);
    const streamDurationMs = formatOptionalMetricCell(executionResult.providerTelemetry?.streamDurationMs);
    const serverProcessingMs = formatOptionalMetricCell(executionResult.providerTelemetry?.serverProcessingMs);
    const requestId = executionResult.providerTelemetry?.requestId ?? '';
    const preAttemptMs = formatOptionalMetricCell(executionResult.providerTelemetry?.preAttemptMs);
    const outputLength = String(responseText.length);
    const hotkeyPressToAcceptMs =
      formatOptionalMetricCell(executionResult.hotkeyPressToAcceptMs);

    const runOutputRecord = [
      row.test,
      row.targetOutput,
      firstChunkCell,
      String(totalDurationMs),
      status,
      matchTargetOutput,
      contextCharCount,
      instructionsCharCount,
      inputCharsEstimate,
      inputTokensEstimate,
      responseText,
      benchmarkMode,
      prefixChars,
      suffixChars,
      extraContextChars,
      scenarioChars,
      constraintChars,
      beforeLinesCount,
      headersLatencyMs,
      firstRawChunkMs,
      firstPayloadMs,
      firstTextMs,
      streamDurationMs,
      serverProcessingMs,
      requestId,
      rowTags,
      preAttemptMs,
      hotkeyPressToAcceptMs,
    ];

    const historyRecord = [
      runId,
      runStartedAtIso,
      row.test,
      row.targetOutput,
      firstChunkCell,
      String(totalDurationMs),
      status,
      matchTargetOutput,
      outputLength,
      rowLanguageId,
      rowFilePath,
      options.model,
      options.endpoint,
      contextCharCount,
      instructionsCharCount,
      inputCharsEstimate,
      inputTokensEstimate,
      benchmarkMode,
      prefixChars,
      suffixChars,
      extraContextChars,
      scenarioChars,
      constraintChars,
      beforeLinesCount,
      headersLatencyMs,
      firstRawChunkMs,
      firstPayloadMs,
      firstTextMs,
      streamDurationMs,
      serverProcessingMs,
      requestId,
      rowTags,
      preAttemptMs,
      hotkeyPressToAcceptMs,
    ];

    try {
      await fs.appendFile(
        runOutputPath,
        `${runOutputRecord.map(escapeCsvCell).join(',')}\n`,
        'utf8',
      );
      await fs.appendFile(
        historyPath,
        `${historyRecord.map(escapeCsvCell).join(',')}\n`,
        'utf8',
      );
      completedRows += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      options.output.appendLine(
        `Failed writing response-time row ${index + 1}: ${message}`,
      );
      continue;
    }

    const preview = responseText.replace(/\s+/g, ' ').trim().slice(0, 120);
    const matchLabel = isScenarioDependent ? 'n/a' : matchTargetOutput;
    const infoLogEmitMs = formatOptionalMetricCell(executionResult.loggingImpact?.infoEmitMs);
    const debugLogEmitMs = formatOptionalMetricCell(executionResult.loggingImpact?.debugEmitMs);
    const infoLogEmitted = executionResult.loggingImpact?.infoEmitted ?? 'n/a';
    const debugLogEmitted = executionResult.loggingImpact?.debugEmitted ?? 'n/a';
    const infoLogSuppressed = executionResult.loggingImpact?.infoSuppressed ?? 'n/a';
    const debugLogSuppressed = executionResult.loggingImpact?.debugSuppressed ?? 'n/a';
    options.output.appendLine(
      `Row ${index + 1}/${rows.length} | firstChunk=${firstChunkCell || 'n/a'}ms | total=${totalDurationMs}ms | hotkey_accept_ms=${hotkeyPressToAcceptMs} | pre_attempt_ms=${preAttemptMs} | info_log_emit_ms=${infoLogEmitMs} | debug_log_emit_ms=${debugLogEmitMs} | info_log_emitted=${infoLogEmitted} | debug_log_emitted=${debugLogEmitted} | info_log_suppressed=${infoLogSuppressed} | debug_log_suppressed=${debugLogSuppressed} | headers_ms=${headersLatencyMs} | first_raw_ms=${firstRawChunkMs} | first_payload_ms=${firstPayloadMs} | first_text_ms=${firstTextMs} | stream_ms=${streamDurationMs} | server_ms=${serverProcessingMs} | input_chars_est=${inputCharsEstimate} | prefix_chars=${prefixChars} | suffix_chars=${suffixChars} | extra_context_chars=${extraContextChars} | scenario_chars=${scenarioChars} | constraint_chars=${constraintChars} | before_lines=${beforeLinesCount} | row_tags=${rowTags || 'n/a'} | status=${status} | match=${matchLabel} | request_id=${requestId || 'n/a'} | output=${preview || '<empty>'}`,
    );
  }

  options.output.appendLine(`Response-time run output: ${runOutputPath}`);
  options.output.appendLine(`Response-time history: ${historyPath}`);
  options.output.appendLine(`Recorded ${completedRows} rows for run ${runId}`);
}

async function runAutomaticDirectBenchmark(input: {
  provider: AIProvider;
  requestContext: ResponseTimeRequestContext;
  rowLanguageId: string;
  rowFilePath: string;
  rowTest: string;
  rowTargetOutput: string;
  rowTags?: string[];
  lockQuotes?: boolean;
  lockArgForm?: boolean;
  lockObjectKeyOrder?: boolean;
  lockDelimiterSpacing?: boolean;
  baseInstructions: string;
  maxOutputTokens?: number;
  serviceTier?: string;
  promptCacheKey?: string;
  promptCacheRetention?: string;
}): Promise<ExecutedRequestSummary> {
  const instructionSet = buildBenchmarkInstructionSet({
    baseInstructions: input.baseInstructions,
    rowTest: input.rowTest,
    prefix: input.requestContext.prefix,
    suffix: input.requestContext.suffix,
    languageId: input.rowLanguageId,
    linePrefix: input.requestContext.linePrefix,
    lineSuffix: input.requestContext.lineSuffix,
    targetOutput: input.rowTargetOutput,
    lockQuotes: input.lockQuotes,
    lockArgForm: input.lockArgForm,
    lockObjectKeyOrder: input.lockObjectKeyOrder,
    lockDelimiterSpacing: input.lockDelimiterSpacing,
    includeScenario: false,
  });
  let providerTelemetry: CompletionRequestTelemetry | undefined;
  const request = {
    prefix: input.requestContext.prefix,
    suffix: input.requestContext.suffix,
    linePrefix: input.requestContext.linePrefix,
    lineSuffix: input.requestContext.lineSuffix,
    languageId: input.rowLanguageId,
    filePath: input.rowFilePath,
    context: undefined,
    instructions: instructionSet.instructions,
    maxOutputTokens: input.maxOutputTokens,
    serviceTier: input.serviceTier,
    promptCacheKey: input.promptCacheKey,
    promptCacheRetention: input.promptCacheRetention,
    interactionMode: 'automatic' as const,
    onTelemetry: (telemetry: CompletionRequestTelemetry) => {
      providerTelemetry = telemetry;
    },
  };
  codexLog(
    `[codex] benchmark request ${formatCompletionRequestLogFields(
      buildCompletionRequestLogFields(request, {
        source: 'response_time_runner',
        benchmarkMode: 'automatic_direct',
      }),
    )}`,
  );

  let responseText = '';
  let firstChunkMs: number | undefined;
  const startedAtMs = Date.now();
  let status: 'success' | 'empty' | 'error' = 'empty';
  const controller = new AbortController();

  try {
    for await (const chunk of input.provider.streamCompletion(request, controller.signal)) {
      if (chunk.done) {
        break;
      }
      if (firstChunkMs === undefined) {
        firstChunkMs = Date.now() - startedAtMs;
      }
      responseText += chunk.text;
    }
    responseText = postProcessGhostTextSuggestion({
      suggestion: responseText,
      timedOutBeforeFirstChunk: false,
      prefix: input.requestContext.prefix,
      suffix: input.requestContext.suffix,
      filePath: request.filePath,
      linePrefix: input.requestContext.linePrefix,
      lineSuffix: input.requestContext.lineSuffix,
      languageId: input.rowLanguageId,
      beforeLines: input.requestContext.beforeLines,
    }).text;
    status = responseText.trim().length > 0 ? 'success' : 'empty';
  } catch (err) {
    const message = formatErrorWithCauses(err);
    responseText = `[ERROR] ${message}`;
    status = 'error';
  }

  return {
    request: {
      prefix: request.prefix,
      suffix: request.suffix,
      languageId: request.languageId,
      filePath: request.filePath,
      context: request.context,
      instructions: request.instructions,
    },
    responseText,
    firstChunkMs,
    totalDurationMs: Date.now() - startedAtMs,
    hotkeyPressToAcceptMs: undefined,
    status,
    requestMetrics: {
      scenarioChars: instructionSet.scenarioChars,
      constraintChars: instructionSet.constraintChars,
      beforeLinesCount: input.requestContext.beforeLines?.length ?? 0,
      rowTags: inferRowTags({
        rowTest: input.rowTest,
        targetOutput: input.rowTargetOutput,
        request,
        explicitRowTags: input.rowTags,
      }),
    },
    providerTelemetry,
  };
}

async function runHotkeyInlineBenchmark(input: {
  provider: AIProvider;
  requestContext: ResponseTimeRequestContext;
  rowLanguageId: string;
  rowFilePath: string;
  rowTest: string;
  rowTargetOutput: string;
  rowTags?: string[];
  lockQuotes?: boolean;
  lockArgForm?: boolean;
  lockObjectKeyOrder?: boolean;
  lockDelimiterSpacing?: boolean;
  baseInstructions: string;
  maxOutputTokens?: number;
  serviceTier?: string;
  promptCacheKey?: string;
  promptCacheRetention?: string;
  rowIndex: number;
  hotkeyMaxLatencyMs: number;
  hotkeyFirstChunkMaxLatencyMs: number;
  hotkeyFastStageMaxLatencyMs: number;
  hotkeyFastStagePrefixLines: number;
  hotkeyFastStageSuffixLines: number;
  hotkeySemanticRetryEnabled: boolean;
  hotkeySemanticRetryMaxLatencyMs: number;
  hotkeySemanticRetryFirstChunkMaxLatencyMs: number;
}): Promise<ExecutedRequestSummary> {
  const instructionSet = buildBenchmarkInstructionSet({
    baseInstructions: input.baseInstructions,
    rowTest: input.rowTest,
    prefix: input.requestContext.prefix,
    suffix: input.requestContext.suffix,
    languageId: input.rowLanguageId,
    linePrefix: input.requestContext.linePrefix,
    lineSuffix: input.requestContext.lineSuffix,
    targetOutput: input.rowTargetOutput,
    lockQuotes: input.lockQuotes,
    lockArgForm: input.lockArgForm,
    lockObjectKeyOrder: input.lockObjectKeyOrder,
    lockDelimiterSpacing: input.lockDelimiterSpacing,
    includeScenario: true,
  });
  const hotkeyResult = await runHotkeyGhostTextFlow({
    provider: input.provider,
    source: 'response_time_runner',
    editorKey: `response-time:${input.rowFilePath}:${input.rowIndex}`,
    contextHash: input.requestContext.hash ?? `row-${input.rowIndex}`,
    requestContext: input.requestContext,
    rowLanguageId: input.rowLanguageId,
    rowFilePath: input.rowFilePath,
    instructions: instructionSet.instructions,
    instructionsPrebuilt: true,
    maxOutputTokens: input.maxOutputTokens,
    serviceTier: input.serviceTier,
    promptCacheKey: input.promptCacheKey,
    promptCacheRetention: input.promptCacheRetention,
    hotkeyMaxLatencyMs: input.hotkeyMaxLatencyMs,
    hotkeyFirstChunkMaxLatencyMs: input.hotkeyFirstChunkMaxLatencyMs,
    hotkeyFastStageMaxLatencyMs: input.hotkeyFastStageMaxLatencyMs,
    hotkeyFastStagePrefixLines: input.hotkeyFastStagePrefixLines,
    hotkeyFastStageSuffixLines: input.hotkeyFastStageSuffixLines,
    hotkeySemanticRetryEnabled: input.hotkeySemanticRetryEnabled,
    hotkeySemanticRetryMaxLatencyMs: input.hotkeySemanticRetryMaxLatencyMs,
    hotkeySemanticRetryFirstChunkMaxLatencyMs: input.hotkeySemanticRetryFirstChunkMaxLatencyMs,
  });

  return {
    request: {
      prefix: hotkeyResult.estimatedRequest.prefix,
      suffix: hotkeyResult.estimatedRequest.suffix,
      languageId: hotkeyResult.estimatedRequest.languageId,
      filePath: hotkeyResult.estimatedRequest.filePath,
      context: hotkeyResult.estimatedRequest.context,
      instructions: hotkeyResult.estimatedRequest.instructions ?? instructionSet.instructions,
    },
    responseText: hotkeyResult.responseText,
    firstChunkMs: hotkeyResult.firstChunkMs,
    totalDurationMs: hotkeyResult.totalDurationMs,
    hotkeyPressToAcceptMs: hotkeyResult.hotkeyPressToAcceptMs,
    status: hotkeyResult.status,
    requestMetrics: {
      scenarioChars: instructionSet.scenarioChars,
      constraintChars: instructionSet.constraintChars,
      beforeLinesCount: input.requestContext.beforeLines?.length ?? 0,
      rowTags: inferRowTags({
        rowTest: input.rowTest,
        targetOutput: input.rowTargetOutput,
        request: {
          prefix: hotkeyResult.estimatedRequest.prefix,
          suffix: hotkeyResult.estimatedRequest.suffix,
          languageId: hotkeyResult.estimatedRequest.languageId,
          filePath: hotkeyResult.estimatedRequest.filePath,
          context: hotkeyResult.estimatedRequest.context,
        },
        explicitRowTags: input.rowTags,
      }),
    },
    providerTelemetry: hotkeyResult.providerTelemetry,
    loggingImpact: hotkeyResult.loggingImpact
      ? {
        infoEmitted: hotkeyResult.loggingImpact.info.emitted,
        infoSuppressed: hotkeyResult.loggingImpact.info.suppressed,
        infoEmitMs: hotkeyResult.loggingImpact.info.emitTimeMs,
        debugEmitted: hotkeyResult.loggingImpact.debug.emitted,
        debugSuppressed: hotkeyResult.loggingImpact.debug.suppressed,
        debugEmitMs: hotkeyResult.loggingImpact.debug.emitTimeMs,
      }
      : undefined,
  };
}

function buildScenarioInstructions(baseInstructions: string, rowTest: string): string {
  return `${baseInstructions}

Response-time scenario:
${rowTest}`;
}

function buildBenchmarkInstructionSet(input: {
  baseInstructions: string;
  rowTest: string;
  prefix: string;
  suffix: string;
  languageId: string;
  linePrefix?: string;
  lineSuffix?: string;
  targetOutput: string;
  lockQuotes?: boolean;
  lockArgForm?: boolean;
  lockObjectKeyOrder?: boolean;
  lockDelimiterSpacing?: boolean;
  includeScenario: boolean;
}): {
  instructions: string;
  scenarioChars: number;
  constraintChars: number;
} {
  const benchmarkInstructions = input.includeScenario
    ? buildScenarioInstructions(input.baseInstructions, input.rowTest)
    : input.baseInstructions;
  const instructions = buildInlineRequestInstructions(
    benchmarkInstructions,
    input.prefix,
    input.suffix,
    {
      languageId: input.languageId,
      linePrefix: input.linePrefix,
      lineSuffix: input.lineSuffix,
      targetOutput: input.targetOutput,
      lockQuotes: input.lockQuotes,
      lockArgForm: input.lockArgForm,
      lockObjectKeyOrder: input.lockObjectKeyOrder,
      lockDelimiterSpacing: input.lockDelimiterSpacing,
    },
  ) ?? benchmarkInstructions;

  return {
    instructions,
    scenarioChars: Math.max(0, benchmarkInstructions.length - input.baseInstructions.length),
    constraintChars: Math.max(0, instructions.length - benchmarkInstructions.length),
  };
}

function normalizeBenchmarkMode(value: ResponseTimeBenchmarkMode | undefined): ResponseTimeBenchmarkMode {
  if (value === 'automatic_direct') {
    return 'automatic_direct';
  }
  return 'hotkey_inline';
}

function isScenarioDependentTargetOutput(targetOutput: string): boolean {
  return targetOutput.trim() === SCENARIO_DEPENDENT_TARGET_OUTPUT;
}

function formatOptionalMetricCell(value: number | undefined): string {
  return value === undefined ? 'n/a' : String(value);
}

async function ensureHistoryFile(historyPath: string): Promise<void> {
  try {
    const existing = await fs.readFile(historyPath, 'utf8');
    const firstLine = existing.split(/\r?\n/)[0] ?? '';
    if (firstLine === HISTORY_HEADER) {
      return;
    }
    if (firstLine === HISTORY_HEADER_V2) {
      const lines = existing.split(/\r?\n/).filter((line) => line.length > 0);
      const migratedRows = lines
        .slice(1)
        .map((line) => appendEmptyCsvCells(line, HISTORY_INSTRUMENTATION_COLUMN_COUNT));
      await fs.writeFile(
        historyPath,
        `${[HISTORY_HEADER, ...migratedRows].join('\n')}\n`,
        'utf8',
      );
      return;
    }
    if (firstLine === HISTORY_HEADER_V1) {
      const lines = existing.split(/\r?\n/).filter((line) => line.length > 0);
      const migratedRows = lines
        .slice(1)
        .map((line) => appendEmptyCsvCells(line, 1 + HISTORY_INSTRUMENTATION_COLUMN_COUNT));
      await fs.writeFile(
        historyPath,
        `${[HISTORY_HEADER, ...migratedRows].join('\n')}\n`,
        'utf8',
      );
      return;
    }
    if (firstLine === LEGACY_HISTORY_HEADER) {
      const lines = existing.split(/\r?\n/).filter((line) => line.length > 0);
      const migratedRows = lines
        .slice(1)
        .map((line) => appendEmptyCsvCells(line, 5 + HISTORY_INSTRUMENTATION_COLUMN_COUNT));
      await fs.writeFile(
        historyPath,
        `${[HISTORY_HEADER, ...migratedRows].join('\n')}\n`,
        'utf8',
      );
      return;
    }
  } catch (err) {
    const code =
      typeof err === 'object'
      && err !== null
      && 'code' in err
      && typeof (err as { code?: unknown }).code === 'string'
        ? (err as { code: string }).code
        : undefined;
    if (code === 'ENOENT') {
      await fs.writeFile(historyPath, `${HISTORY_HEADER}\n`, 'utf8');
      return;
    }
    throw err;
  }
}

function appendEmptyCsvCells(line: string, count: number): string {
  if (count <= 0) {
    return line;
  }
  return `${line}${','.repeat(count)}`;
}

async function seedHistoryFromLegacyPaths(
  historyPath: string,
  legacyHistoryPaths: string[],
): Promise<void> {
  try {
    await fs.readFile(historyPath, 'utf8');
    return;
  } catch (err) {
    const code =
      typeof err === 'object'
      && err !== null
      && 'code' in err
      && typeof (err as { code?: unknown }).code === 'string'
        ? (err as { code: string }).code
        : undefined;
    if (code !== 'ENOENT') {
      throw err;
    }
  }

  for (const legacyHistoryPath of legacyHistoryPaths) {
    try {
      const legacyContent = await fs.readFile(legacyHistoryPath, 'utf8');
      await fs.writeFile(historyPath, legacyContent, 'utf8');
      return;
    } catch (err) {
      const code =
        typeof err === 'object'
        && err !== null
        && 'code' in err
        && typeof (err as { code?: unknown }).code === 'string'
          ? (err as { code: string }).code
          : undefined;
      if (code !== 'ENOENT') {
        throw err;
      }
    }
  }
}

function parseResponseTimeInputJson(json: string): ResponseTimeTestRow[] {
  const parsed = JSON.parse(json) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('Input JSON must be an array of objects');
  }

  if (parsed.length === 0) {
    return [];
  }

  return parsed.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`Row ${index + 1} must be an object with "test" and "target_output"`);
    }
    const test = asRequiredString(item.test, `Row ${index + 1} missing required "test"`);
    const targetOutput = asRequiredString(
      item.target_output,
      `Row ${index + 1} missing required "target_output"`,
    );
    const filePath = asOptionalString(item.file_path, `Row ${index + 1} has invalid "file_path"`);
    const languageId = asOptionalString(
      item.language_id,
      `Row ${index + 1} has invalid "language_id"`,
    );
    const cursorAfter = asOptionalString(
      item.cursor_after,
      `Row ${index + 1} has invalid "cursor_after"`,
    );
    const cursorAfterOccurrence = asOptionalPositiveInteger(
      item.cursor_after_occurrence,
      `Row ${index + 1} has invalid "cursor_after_occurrence"`,
    );
    const cursorLine = asOptionalPositiveInteger(
      item.cursor_line,
      `Row ${index + 1} has invalid "cursor_line"`,
    );
    const cursorChar = asOptionalPositiveInteger(
      item.cursor_char,
      `Row ${index + 1} has invalid "cursor_char"`,
    );
    const lockQuotes = asOptionalBoolean(
      item.lock_quotes,
      `Row ${index + 1} has invalid "lock_quotes"`,
    );
    const lockArgForm = asOptionalBoolean(
      item.lock_arg_form,
      `Row ${index + 1} has invalid "lock_arg_form"`,
    );
    const lockObjectKeyOrder = asOptionalBoolean(
      item.lock_object_key_order,
      `Row ${index + 1} has invalid "lock_object_key_order"`,
    );
    const lockDelimiterSpacing = asOptionalBoolean(
      item.lock_delimiter_spacing,
      `Row ${index + 1} has invalid "lock_delimiter_spacing"`,
    );
    const rowTags = asOptionalStringArray(
      item.row_tags,
      `Row ${index + 1} has invalid "row_tags"`,
    );
    return {
      test,
      targetOutput,
      filePath,
      languageId,
      cursorAfter,
      cursorAfterOccurrence,
      cursorLine,
      cursorChar,
      lockQuotes,
      lockArgForm,
      lockObjectKeyOrder,
      lockDelimiterSpacing,
      rowTags,
    };
  });
}

function escapeCsvCell(value: string): string {
  const escaped = value.replace(/"/g, '""');
  return /[",\n]/.test(value) ? `"${escaped}"` : escaped;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asRequiredString(value: unknown, errorMessage: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(errorMessage);
  }
  return value;
}

function asOptionalString(value: unknown, errorMessage: string): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(errorMessage);
  }
  return value;
}

function asOptionalPositiveInteger(value: unknown, errorMessage: string): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(errorMessage);
  }
  return value;
}

function asOptionalBoolean(value: unknown, errorMessage: string): boolean | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw new Error(errorMessage);
  }
  return value;
}

function asOptionalStringArray(value: unknown, errorMessage: string): string[] | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new Error(errorMessage);
  }
  return [...new Set(value)];
}

function inferRowTags(input: {
  rowTest: string;
  targetOutput: string;
  request: {
    prefix: string;
    suffix: string;
    languageId: string;
    filePath: string;
    context?: string;
  };
  explicitRowTags?: string[];
}): string[] {
  const tags = new Set<string>(input.explicitRowTags ?? []);
  const lowerTest = input.rowTest.toLowerCase();
  const lowerFilePath = input.request.filePath.toLowerCase();
  const target = input.targetOutput.trim();
  const combinedChars =
    input.request.prefix.length
    + input.request.suffix.length
    + (input.request.context?.length ?? 0);

  if (isScenarioDependentTargetOutput(input.targetOutput)) {
    tags.add('scenario_dependent');
  }
  if (/\bnearduplicate\b|\bnear-duplicate\b/.test(lowerTest) || lowerFilePath.includes('near_duplicate')) {
    tags.add('near_duplicate');
  }
  if (/\bboundary\b|\blarge file\b/.test(lowerTest) || combinedChars >= 6000) {
    tags.add('large_file');
  }
  if (/\bchain\b/.test(lowerTest) || input.request.prefix.includes('.')) {
    tags.add('chain');
  }
  if (/^\W+$/.test(target)) {
    tags.add('punctuation_only');
  }
  if (/\b[A-Za-z_][A-Za-z0-9_]*\s*=/.test(target)) {
    tags.add('named_args');
  }
  if (/\d/.test(target)) {
    tags.add('numeric_literal');
  }
  if (/[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z0-9_]*$/.test(input.request.prefix)) {
    tags.add('member_suffix');
  }
  if ((input.request.context?.length ?? 0) > 0) {
    tags.add('extra_context');
  }
  if (input.request.languageId) {
    tags.add(`lang:${input.request.languageId}`);
  }

  return [...tags].sort((left, right) => left.localeCompare(right));
}

function resolveRowFilePath(workspaceFolder: string, filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.join(workspaceFolder, filePath);
}

function estimateInputChars(request: {
  prefix: string;
  suffix: string;
  languageId: string;
  filePath: string;
  context?: string;
  instructions: string;
}): number {
  // Approximate provider prompt assembly (sections + labels + metadata lines).
  const structuralOverhead =
    220
    + request.languageId.length
    + request.filePath.length;
  return (
    request.prefix.length
    + request.suffix.length
    + (request.context?.length ?? 0)
    + request.instructions.length
    + structuralOverhead
  );
}

function estimateInputTokens(inputChars: number): number {
  return Math.max(1, Math.ceil(inputChars / 4));
}

function formatTimestamp(date: Date): string {
  const pad = (value: number): string => value.toString().padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
