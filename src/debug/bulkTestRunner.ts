import * as fs from 'fs/promises';
import * as path from 'path';
import { AIProvider } from '../api/aiProvider';
import { CompletionPayload } from '../completion/completionPipeline';
import { COMPLETION_CONSTRAINT_LINES } from '../completion/completionInstructions';
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

interface BulkTestRow {
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
}

interface BulkTestResultRow {
  test: string;
  targetOutput: string;
  context: string;
  output: string;
}

type ParsedBulkContext = NormalizedInlineRequestContext;

type BulkRetryReason = 'empty_output' | 'numeric_literal_mismatch' | 'semantic_mismatch';
type BulkBenchmarkMode = 'direct' | 'hotkey_inline';

interface BulkTestRunnerOptions {
  workspaceFolder: string;
  output: {
    appendLine(line: string): void;
  };
  provider: AIProvider;
  languageId: string;
  filePath: string;
  instructions: string;
  maxOutputTokens?: number;
  serviceTier?: string;
  promptCacheKey?: string;
  promptCacheRetention?: string;
  buildContext: () => string | Promise<string>;
  buildContextForRow?: (row: BulkTestRow) => string | Promise<string>;
  maxRetries?: number;
  numericLiteralMismatchMaxRetries?: number;
  numericLiteralGuardEnabled?: boolean;
  semanticMismatchMaxRetries?: number;
  semanticMismatchGuardEnabled?: boolean;
  benchmarkMode?: BulkBenchmarkMode;
  hotkeyMaxLatencyMs?: number;
  hotkeyFirstChunkMaxLatencyMs?: number;
  hotkeyFastStageMaxLatencyMs?: number;
  hotkeyFastStagePrefixLines?: number;
  hotkeyFastStageSuffixLines?: number;
  hotkeySemanticRetryEnabled?: boolean;
  hotkeySemanticRetryMaxLatencyMs?: number;
  hotkeySemanticRetryFirstChunkMaxLatencyMs?: number;
  testPattern?: string;
  inputFilePath?: string;
  timestamp?: Date;
}

interface BulkAttemptResult {
  output: string;
  firstChunkMs?: number;
  totalDurationMs: number;
}

interface DirectAttemptInput {
  provider: AIProvider;
  rowLanguageId: string;
  rowFilePath: string;
  requestContext: ParsedBulkContext;
  requestInstructions: string;
  maxOutputTokens?: number;
  serviceTier?: string;
  promptCacheKey?: string;
  promptCacheRetention?: string;
}

interface HotkeyInlineAttemptInput extends DirectAttemptInput {
  rowIndex: number;
  attempt: number;
  contextHash?: string;
  beforeLines?: string[];
  hotkeyMaxLatencyMs: number;
  hotkeyFirstChunkMaxLatencyMs: number;
  hotkeyFastStageMaxLatencyMs: number;
  hotkeyFastStagePrefixLines: number;
  hotkeyFastStageSuffixLines: number;
  hotkeySemanticRetryEnabled: boolean;
  hotkeySemanticRetryMaxLatencyMs: number;
  hotkeySemanticRetryFirstChunkMaxLatencyMs: number;
}

const BULK_TEST_INSTRUCTIONS_SUFFIX = [
  'Bulk test completion constraints:',
  ...COMPLETION_CONSTRAINT_LINES,
].join('\n');
const DEFAULT_BENCHMARK_MODE: BulkBenchmarkMode = 'hotkey_inline';
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

export async function runAutocompleteBulkTest(
  options: BulkTestRunnerOptions,
): Promise<void> {
  const inputPath = options.inputFilePath
    ? (path.isAbsolute(options.inputFilePath)
      ? options.inputFilePath
      : path.join(options.workspaceFolder, options.inputFilePath))
    : path.join(options.workspaceFolder, 'test_files', 'autocomplete_test_input.json');
  const artifactDir = path.join(options.workspaceFolder, 'test_artifacts');
  const outputPath = path.join(
    artifactDir,
    `autocomplete_test_output_${formatTimestamp(options.timestamp ?? new Date())}.csv`,
  );

  let rows: BulkTestRow[];
  try {
    const json = await fs.readFile(inputPath, 'utf8');
    rows = parseBulkTestInputJson(json);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    options.output.appendLine(`Failed reading input JSON (${inputPath}): ${message}`);
    return;
  }

  if (rows.length === 0) {
    options.output.appendLine(`No rows found in ${inputPath}`);
    return;
  }

  if (options.testPattern) {
    const matcher = buildTestPatternMatcher(options.testPattern);
    if (!matcher) {
      options.output.appendLine(
        `Invalid --test-pattern (${options.testPattern}). Use plain text or /regex/flags.`,
      );
      return;
    }
    const beforeCount = rows.length;
    rows = rows.filter((row) => matcher.match(row.test));
    options.output.appendLine(
      `Applied test pattern ${matcher.label} | matched=${rows.length}/${beforeCount}`,
    );
    if (rows.length === 0) {
      options.output.appendLine('No rows matched --test-pattern');
      return;
    }
  }

  try {
    await fs.mkdir(artifactDir, { recursive: true });
    await fs.writeFile(outputPath, 'test,target_output,context,output\n', 'utf8');
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    options.output.appendLine(`Failed creating output CSV (${outputPath}): ${message}`);
    return;
  }

  let completedRows = 0;
  const completedFirstChunkMs: number[] = [];
  const completedTotalDurationMs: number[] = [];
  const emptyOutputMaxRetries = Math.max(0, options.maxRetries ?? 1);
  const numericLiteralMismatchMaxRetries = Math.max(
    0,
    options.numericLiteralMismatchMaxRetries
      ?? (options.maxRetries === undefined ? 2 : emptyOutputMaxRetries),
  );
  const semanticMismatchMaxRetries = Math.max(
    0,
    options.semanticMismatchMaxRetries
      ?? (options.maxRetries === undefined ? 2 : emptyOutputMaxRetries),
  );
  const maxAttempts = Math.max(
    emptyOutputMaxRetries + 1,
    numericLiteralMismatchMaxRetries + 1,
    semanticMismatchMaxRetries + 1,
  );
  const numericLiteralGuardEnabled = options.numericLiteralGuardEnabled ?? true;
  const semanticMismatchGuardEnabled = options.semanticMismatchGuardEnabled ?? true;
  const benchmarkMode = normalizeBenchmarkMode(options.benchmarkMode);
  const hotkeyMaxLatencyMs = options.hotkeyMaxLatencyMs ?? DEFAULT_HOTKEY_MAX_LATENCY_MS;
  const hotkeyFirstChunkMaxLatencyMs =
    options.hotkeyFirstChunkMaxLatencyMs ?? DEFAULT_HOTKEY_FIRST_CHUNK_MAX_LATENCY_MS;
  const hotkeyFastStageMaxLatencyMs =
    options.hotkeyFastStageMaxLatencyMs ?? DEFAULT_HOTKEY_FAST_STAGE_MAX_LATENCY_MS;
  const hotkeyFastStagePrefixLines =
    options.hotkeyFastStagePrefixLines ?? DEFAULT_HOTKEY_FAST_STAGE_PREFIX_LINES;
  const hotkeyFastStageSuffixLines =
    options.hotkeyFastStageSuffixLines ?? DEFAULT_HOTKEY_FAST_STAGE_SUFFIX_LINES;
  const hotkeySemanticRetryEnabled =
    options.hotkeySemanticRetryEnabled ?? DEFAULT_HOTKEY_SEMANTIC_RETRY_ENABLED;
  const hotkeySemanticRetryMaxLatencyMs =
    options.hotkeySemanticRetryMaxLatencyMs ?? DEFAULT_HOTKEY_SEMANTIC_RETRY_MAX_LATENCY_MS;
  const hotkeySemanticRetryFirstChunkMaxLatencyMs =
    options.hotkeySemanticRetryFirstChunkMaxLatencyMs
    ?? DEFAULT_HOTKEY_SEMANTIC_RETRY_FIRST_CHUNK_MAX_LATENCY_MS;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    options.output.appendLine(`Processing row ${index + 1}/${rows.length}...`);

    const computedContext = await (
      options.buildContextForRow ? options.buildContextForRow(row) : options.buildContext()
    );
    const parsedContext = normalizeInlineRequestContext(computedContext);
    const rowFilePath = resolveRowFilePath(
      options.workspaceFolder,
      row.filePath ?? options.filePath,
    );
    const rowLanguageId = row.languageId ?? options.languageId;
    let normalizedOutput = '';
    let firstChunkMs: number | undefined;
    let totalDurationMs = 0;
    let retryReason: BulkRetryReason | undefined;
    let attemptsUsed = 0;
    let attemptBudgetUsed = emptyOutputMaxRetries + 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      attemptsUsed = attempt;
      const requestInstructions = buildBulkInstructions(
        options.instructions,
        row,
        retryReason,
      );
      const attemptResult = benchmarkMode === 'hotkey_inline'
        ? await runHotkeyInlineAttempt({
          provider: options.provider,
          rowFilePath,
          rowLanguageId,
          rowIndex: index,
          attempt,
          requestContext: parsedContext,
          requestInstructions,
          promptCacheKey: options.promptCacheKey,
          promptCacheRetention: options.promptCacheRetention,
          maxOutputTokens: options.maxOutputTokens,
          serviceTier: options.serviceTier,
          beforeLines: parsedContext.beforeLines,
          contextHash: parsedContext.hash,
          hotkeyMaxLatencyMs,
          hotkeyFirstChunkMaxLatencyMs,
          hotkeyFastStageMaxLatencyMs,
          hotkeyFastStagePrefixLines,
          hotkeyFastStageSuffixLines,
          hotkeySemanticRetryEnabled,
          hotkeySemanticRetryMaxLatencyMs,
          hotkeySemanticRetryFirstChunkMaxLatencyMs,
        })
        : await runDirectAttempt({
          provider: options.provider,
          rowFilePath,
          rowLanguageId,
          requestContext: parsedContext,
          requestInstructions,
          maxOutputTokens: options.maxOutputTokens,
          serviceTier: options.serviceTier,
          promptCacheKey: options.promptCacheKey,
          promptCacheRetention: options.promptCacheRetention,
        });

      const attemptDurationMs = attemptResult.totalDurationMs;
      totalDurationMs += attemptDurationMs;
      if (firstChunkMs === undefined && attemptResult.firstChunkMs !== undefined) {
        firstChunkMs = totalDurationMs - attemptDurationMs + attemptResult.firstChunkMs;
      }

      normalizedOutput = attemptResult.output;

      retryReason = getRetryReason({
        output: normalizedOutput,
        targetOutput: row.targetOutput,
        numericLiteralGuardEnabled,
        semanticMismatchGuardEnabled,
      });
      if (!retryReason) {
        break;
      }

      const maxAttemptsForReason = retryReason === 'numeric_literal_mismatch'
        ? numericLiteralMismatchMaxRetries + 1
        : retryReason === 'semantic_mismatch'
          ? semanticMismatchMaxRetries + 1
          : emptyOutputMaxRetries + 1;
      attemptBudgetUsed = Math.max(attemptBudgetUsed, maxAttemptsForReason);

      if (attempt < maxAttemptsForReason) {
        options.output.appendLine(
          `Row ${index + 1}/${rows.length} retrying attempt ${attempt + 1}/${maxAttemptsForReason} reason=${retryReason}`,
        );
        continue;
      }

      break;
    }

    const result: BulkTestResultRow = {
      test: row.test,
      targetOutput: row.targetOutput,
      context: computedContext,
      output: normalizedOutput,
    };

    try {
      await fs.appendFile(
        outputPath,
        `${[result.test, result.targetOutput, result.context, result.output].map(escapeCsvCell).join(',')}\n`,
        'utf8',
      );
      completedRows += 1;
      if (firstChunkMs !== undefined) {
        completedFirstChunkMs.push(firstChunkMs);
      }
      completedTotalDurationMs.push(totalDurationMs);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      options.output.appendLine(`Failed appending row ${index + 1} to ${outputPath}: ${message}`);
      continue;
    }

    const preview = normalizedOutput.replace(/\s+/g, ' ').trim().slice(0, 140);
    options.output.appendLine(
      `Row ${index + 1}/${rows.length} complete | attempts=${attemptsUsed}/${attemptBudgetUsed} | first_chunk_ms=${formatMs(firstChunkMs)} | total_duration_ms=${totalDurationMs} | test=${row.test} | target=${row.targetOutput || '<empty>'} | output=${preview || '<empty>'}`,
    );
  }

  if (completedRows > 0) {
    options.output.appendLine(
      `Timing summary | avg_first_chunk_ms=${formatAverageMs(completedFirstChunkMs)} | avg_total_duration_ms=${formatAverageMs(completedTotalDurationMs)}`,
    );
  }
  options.output.appendLine(`Wrote ${completedRows} rows to ${outputPath}`);
}

async function runDirectAttempt(input: DirectAttemptInput): Promise<BulkAttemptResult> {
  const request: CompletionPayload = {
    prefix: input.requestContext.prefix,
    suffix: input.requestContext.suffix,
    linePrefix: input.requestContext.linePrefix,
    lineSuffix: input.requestContext.lineSuffix,
    languageId: input.rowLanguageId,
    filePath: input.rowFilePath,
    context: input.requestContext.context,
    instructions: input.requestInstructions,
    maxOutputTokens: input.maxOutputTokens,
    serviceTier: input.serviceTier,
    promptCacheKey: input.promptCacheKey,
    promptCacheRetention: input.promptCacheRetention,
  };
  codexLog(
    `[codex] benchmark request ${formatCompletionRequestLogFields(
      buildCompletionRequestLogFields(request, {
        source: 'bulk_test_runner',
        benchmarkMode: 'direct',
      }),
    )}`,
  );

  const controller = new AbortController();
  let responseText = '';
  const startedAtMs = Date.now();
  let firstChunkMs: number | undefined;

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
  } catch (err) {
    const message = formatErrorWithCauses(err);
    return {
      output: `[ERROR] ${message}`,
      firstChunkMs,
      totalDurationMs: Date.now() - startedAtMs,
    };
  }

  const processedSuggestion = postProcessGhostTextSuggestion({
    suggestion: responseText,
    timedOutBeforeFirstChunk: false,
    prefix: input.requestContext.prefix,
    suffix: input.requestContext.suffix,
    filePath: input.rowFilePath,
    linePrefix: input.requestContext.linePrefix,
    lineSuffix: input.requestContext.lineSuffix,
    languageId: input.rowLanguageId,
    beforeLines: input.requestContext.beforeLines,
  });

  return {
    output: processedSuggestion.text,
    firstChunkMs,
    totalDurationMs: Date.now() - startedAtMs,
  };
}

async function runHotkeyInlineAttempt(input: HotkeyInlineAttemptInput): Promise<BulkAttemptResult> {
  const attemptResult = await runHotkeyGhostTextFlow({
    provider: input.provider,
    source: 'bulk_test_runner',
    editorKey: `bulk:${input.rowFilePath}:${input.rowIndex}:${input.attempt}`,
    contextHash: input.contextHash ?? `row-${input.rowIndex}-attempt-${input.attempt}`,
    requestContext: input.requestContext,
    rowLanguageId: input.rowLanguageId,
    rowFilePath: input.rowFilePath,
    instructions: input.requestInstructions,
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
    output: attemptResult.responseText,
    firstChunkMs: attemptResult.firstChunkMs,
    totalDurationMs: attemptResult.totalDurationMs,
  };
}

function normalizeBenchmarkMode(value: BulkBenchmarkMode | undefined): BulkBenchmarkMode {
  return value === 'direct' ? 'direct' : DEFAULT_BENCHMARK_MODE;
}

function parseBulkTestInputJson(json: string): BulkTestRow[] {
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
    };
  });
}

interface BulkTestMatcher {
  label: string;
  match(testName: string): boolean;
}

function buildTestPatternMatcher(pattern: string): BulkTestMatcher | undefined {
  const trimmed = pattern.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const parsedRegex = parseRegexLiteral(trimmed);
  if (parsedRegex) {
    try {
      const safeFlags = parsedRegex.flags.replace(/[gy]/g, '');
      const regex = new RegExp(parsedRegex.source, safeFlags);
      return {
        label: `/${parsedRegex.source}/${safeFlags}`,
        match: (testName: string): boolean => regex.test(testName),
      };
    } catch {
      return undefined;
    }
  }

  return {
    label: `contains("${trimmed}")`,
    match: (testName: string): boolean => testName.includes(trimmed),
  };
}

function parseRegexLiteral(value: string): { source: string; flags: string } | undefined {
  if (!value.startsWith('/')) {
    return undefined;
  }
  const finalSlash = value.lastIndexOf('/');
  if (finalSlash <= 0) {
    return undefined;
  }
  return {
    source: value.slice(1, finalSlash),
    flags: value.slice(finalSlash + 1),
  };
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

  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(errorMessage);
  }
  return parsed;
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

function formatTimestamp(date: Date): string {
  const pad = (value: number): string => value.toString().padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function formatMs(value?: number): string {
  return value === undefined ? 'n/a' : String(value);
}

function formatAverageMs(values: number[]): string {
  if (values.length === 0) {
    return 'n/a';
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  return String(Math.round(total / values.length));
}

function resolveRowFilePath(workspaceFolder: string, filePath: string): string {
  if (path.isAbsolute(filePath)) {
    return filePath;
  }
  return path.join(workspaceFolder, filePath);
}

function buildBulkInstructions(
  baseInstructions: string,
  row: BulkTestRow,
  retryReason: BulkRetryReason | undefined,
): string {
  const rowTest = row.test;
  const targetOutput = row.targetOutput;
  const isScenarioDependent = targetOutput.trim() === '<scenario-dependent>';
  const requiredIdentifiers = uniqueStrings(
    extractIdentifierTokens(isScenarioDependent ? '' : targetOutput)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3 && !IDENTIFIER_STOPWORDS.has(token.toLowerCase())),
  ).slice(0, 6);
  const requiredMemberPaths = uniqueStrings(extractMemberPaths(isScenarioDependent ? '' : targetOutput)).slice(0, 6);
  const requiredNamedArguments = uniqueStrings(extractNamedArgumentLabels(isScenarioDependent ? '' : targetOutput)).slice(0, 6);
  const requiredArgumentSequence = (parseTrailingArguments(isScenarioDependent ? '' : targetOutput)?.parts ?? []).slice(0, 6);
  const requiredStringLiterals = uniqueStrings(extractStringLiterals(isScenarioDependent ? '' : targetOutput)).slice(0, 4);
  const requiredNumericLiterals = extractNumericLiterals(isScenarioDependent ? '' : targetOutput);
  const requiredStringLiteralTokens = requiredStringLiterals.map((literal) => JSON.stringify(literal));
  const lockQuotes = row.lockQuotes ?? false;
  const lockArgForm = row.lockArgForm ?? false;
  const lockObjectKeyOrder = row.lockObjectKeyOrder ?? false;
  const lockDelimiterSpacing = row.lockDelimiterSpacing
    ?? hasDelimiterSensitiveStringLiterals(requiredStringLiterals);
  const targetArgForm = inferTargetArgForm(isScenarioDependent ? '' : targetOutput);
  const exactSuffixSnippet = !isScenarioDependent && targetOutput.length <= 48 ? targetOutput : undefined;
  const benchmarkTokenRequirements = [
    'Benchmark token constraints (strict):',
    requiredIdentifiers.length > 0
      ? `- REQUIRED_IDENTIFIERS: ${requiredIdentifiers.join(', ')}`
      : '- REQUIRED_IDENTIFIERS: <none>',
    requiredMemberPaths.length > 0
      ? `- REQUIRED_MEMBER_PATHS: ${requiredMemberPaths.join(', ')}`
      : '- REQUIRED_MEMBER_PATHS: <none>',
    requiredNamedArguments.length > 0
      ? `- REQUIRED_NAMED_ARGS: ${requiredNamedArguments.join(', ')}`
      : '- REQUIRED_NAMED_ARGS: <none>',
    requiredArgumentSequence.length > 0
      ? `- REQUIRED_ARG_SEQUENCE: ${requiredArgumentSequence.join(' | ')}`
      : '- REQUIRED_ARG_SEQUENCE: <none>',
    requiredStringLiteralTokens.length > 0
      ? `- REQUIRED_STRING_LITERALS: ${requiredStringLiteralTokens.join(', ')}`
      : '- REQUIRED_STRING_LITERALS: <none>',
    requiredStringLiteralTokens.length > 0
      ? '- REQUIRED_STRING_LITERAL_LOCK: enabled (never replace required string literals with identifiers/member paths).'
      : '- REQUIRED_STRING_LITERAL_LOCK: disabled.',
    exactSuffixSnippet
      ? `- REQUIRED_EXACT_SUFFIX_SNIPPET: ${JSON.stringify(exactSuffixSnippet)}`
      : '- REQUIRED_EXACT_SUFFIX_SNIPPET: <none>',
    requiredNumericLiterals.length > 0
      ? `- REQUIRED_NUMERIC_LITERALS: ${requiredNumericLiterals.join(', ')}`
      : '- REQUIRED_NUMERIC_LITERALS: <none>',
    lockQuotes ? '- LOCK_QUOTES: enabled (preserve quote delimiters exactly).' : '- LOCK_QUOTES: disabled.',
    lockArgForm
      ? `- LOCK_ARG_FORM: enabled (${targetArgForm} argument form must be preserved).`
      : '- LOCK_ARG_FORM: disabled.',
    lockObjectKeyOrder
      ? '- LOCK_OBJECT_KEY_ORDER: enabled (preserve object-literal key order).'
      : '- LOCK_OBJECT_KEY_ORDER: disabled.',
    lockDelimiterSpacing
      ? '- LOCK_DELIMITER_SPACING: enabled (preserve delimiter spacing in string literals).'
      : '- LOCK_DELIMITER_SPACING: disabled.',
    '- If cursor is inside a call, preserve argument order and argument names implied by local context.',
    '- Do not substitute sibling symbols when required identifiers/member paths are available.',
  ].join('\n');
  const delimiterLockSection = lockDelimiterSpacing
    ? [
      '- Literal delimiter lock is active.',
      requiredStringLiteralTokens.length > 0
        ? `- Preserve delimiter spacing exactly in these string literals: ${requiredStringLiteralTokens.join(', ')}`
        : '- Preserve delimiter spacing exactly in relevant string literals from local context.',
      '- Do not collapse ", " to "," and do not insert/remove spaces inside string delimiters.',
    ]
    : [];
  const requiredStringLiteralSection = requiredStringLiteralTokens.length > 0
    ? [
      '- Required string-literal lock is active.',
      `- Output must preserve these string literal values exactly: ${requiredStringLiteralTokens.join(', ')}`,
      '- Do not replace required string literals with in-scope identifiers, member paths, or aliases.',
    ]
    : [];
  const argFormLockSection = lockArgForm
    ? [
      '- Argument-form lock is active.',
      `- Preserve ${targetArgForm} argument form from the target completion (do not convert positional <-> named).`,
    ]
    : [];
  const quoteLockSection = lockQuotes
    ? [
      '- Quote lock is active.',
      '- Preserve quote delimiters exactly as expected; do not strip or add quotes.',
    ]
    : [];
  const objectKeyOrderLockSection = lockObjectKeyOrder
    ? [
      '- Object-key-order lock is active.',
      '- Preserve object literal key ordering exactly as expected.',
    ]
    : [];

  const semanticRetrySection = retryReason === 'semantic_mismatch'
    ? [
      '- Semantic mismatch detected in previous attempt.',
      exactSuffixSnippet
        ? `- Required exact suffix snippet to preserve: ${JSON.stringify(exactSuffixSnippet)}`
        : '- Preserve exact punctuation/spacing implied by cursor scenario.',
      requiredIdentifiers.length > 0
        ? `- Required identifiers to preserve exactly: ${requiredIdentifiers.join(', ')}`
        : '- Preserve identifier names implied by the cursor context.',
      requiredMemberPaths.length > 0
        ? `- Required member paths to preserve exactly: ${requiredMemberPaths.join(', ')}`
        : '- Preserve member-access paths already implied by local context.',
      requiredNamedArguments.length > 0
        ? `- Required named arguments to preserve exactly: ${requiredNamedArguments.join(', ')}`
        : '- Do not change argument labels or omit existing named-argument intent.',
      requiredArgumentSequence.length > 1
        ? `- Required argument order to preserve exactly: ${requiredArgumentSequence.join(' -> ')}`
        : '- Preserve positional argument order from the target completion.',
      requiredStringLiteralTokens.length > 0
        ? `- Required string literals to preserve exactly: ${requiredStringLiteralTokens.join(', ')}`
        : '- Preserve string literals implied by the cursor context.',
      '- Preserve delimiter spacing inside string literals exactly (example: ", " must not become ",").',
      '- Do not replace member access paths with shorter or unrelated symbols.',
      '- For suffix insertion, prefer local symbols over introducing new literals.',
      '- Do not add/remove internal whitespace inside required exact suffix snippets.',
      ...quoteLockSection,
      ...argFormLockSection,
      ...objectKeyOrderLockSection,
      ...requiredStringLiteralSection,
      ...delimiterLockSection,
    ]
    : [];

  const numericRetrySection = retryReason === 'numeric_literal_mismatch'
    ? [
      '- Numeric mismatch detected in previous attempt.',
      requiredNumericLiterals.length > 0
        ? `- Required numeric literals to reuse exactly: ${requiredNumericLiterals.join(', ')}`
        : '- Do not alter numeric literals from the expected completion.',
      requiredStringLiteralTokens.length > 0
        ? `- Preserve accompanying string literals exactly: ${requiredStringLiteralTokens.join(', ')}`
        : '- Preserve accompanying string literals and delimiter spacing exactly.',
      '- Do not round, scale, or simplify numeric literals (for example: 0.07 must stay 0.07).',
      '- Reuse numeric literals exactly as typed, including decimal precision when present.',
      ...quoteLockSection,
      ...argFormLockSection,
      ...objectKeyOrderLockSection,
      ...requiredStringLiteralSection,
      ...delimiterLockSection,
    ]
    : [];

  const retrySection = retryReason
    ? [
      'Retry requirements:',
      '- Previous attempt did not satisfy strict benchmark checks.',
      `- Retry reason: ${retryReason}`,
      '- Return a non-empty completion.',
      '- Preserve required numeric literals exactly as implied by cursor scenario.',
      ...quoteLockSection,
      ...argFormLockSection,
      ...objectKeyOrderLockSection,
      ...requiredStringLiteralSection,
      ...delimiterLockSection,
      ...semanticRetrySection,
      ...numericRetrySection,
    ].join('\n')
    : undefined;

  return [
    baseInstructions,
    BULK_TEST_INSTRUCTIONS_SUFFIX,
    benchmarkTokenRequirements,
    ...(retrySection ? [retrySection] : []),
    'Bulk test scenario:',
    rowTest,
  ].join('\n\n');
}

function getRetryReason(input: {
  output: string;
  targetOutput: string;
  numericLiteralGuardEnabled: boolean;
  semanticMismatchGuardEnabled: boolean;
}): BulkRetryReason | undefined {
  if (!input.output.trim()) {
    return 'empty_output';
  }

  if (input.numericLiteralGuardEnabled && hasNumericLiteralMismatch(input.targetOutput, input.output)) {
    return 'numeric_literal_mismatch';
  }

  if (input.semanticMismatchGuardEnabled && hasSemanticMismatch(input.targetOutput, input.output)) {
    return 'semantic_mismatch';
  }

  return undefined;
}

function hasNumericLiteralMismatch(targetOutput: string, output: string): boolean {
  const targetNumbers = extractNumericLiterals(targetOutput);
  if (targetNumbers.length === 0) {
    return false;
  }

  const outputNumbers = extractNumericLiterals(output);
  if (outputNumbers.length !== targetNumbers.length) {
    return true;
  }

  for (let index = 0; index < targetNumbers.length; index += 1) {
    const target = Number.parseFloat(targetNumbers[index]);
    const actual = Number.parseFloat(outputNumbers[index]);
    if (!Number.isFinite(target) || !Number.isFinite(actual)) {
      return true;
    }
    if (Math.abs(target - actual) > 1e-9) {
      return true;
    }
  }

  return false;
}

function extractNumericLiterals(value: string): string[] {
  return value.match(/-?\d+(?:\.\d+)?/g) ?? [];
}

const IDENTIFIER_STOPWORDS = new Set([
  'return',
  'const',
  'let',
  'var',
  'new',
  'true',
  'false',
  'null',
  'undefined',
  'if',
  'else',
  'for',
  'while',
  'switch',
  'case',
  'default',
  'class',
  'static',
  'public',
  'private',
  'protected',
  'function',
  'def',
  'import',
  'from',
  'as',
  'and',
  'or',
  'not',
  'in',
]);

function hasSemanticMismatch(targetOutput: string, output: string): boolean {
  const target = targetOutput.trim();
  const actual = output.trim();
  if (!target || !actual || target === actual) {
    return false;
  }

  if (isIdentifierLike(target) && isQuotedLiteralLike(actual)) {
    return true;
  }

  if (hasIdentifierSuffixInflation(target, actual)) {
    return true;
  }

  const targetIdentifiers = uniqueStrings(
    extractIdentifierTokens(target)
      .filter((token) => token.length >= 3 && !IDENTIFIER_STOPWORDS.has(token.toLowerCase())),
  );
  if (targetIdentifiers.length > 0) {
    const matched = targetIdentifiers.filter((token) => containsWord(actual, token)).length;
    if (matched === 0) {
      return true;
    }
    if (targetIdentifiers.length >= 2 && matched / targetIdentifiers.length < 0.5) {
      return true;
    }
  }

  const targetNamedArguments = extractNamedArgumentLabels(target);
  if (targetNamedArguments.length > 0) {
    const missingNamedArgument = targetNamedArguments.some((label) => !containsNamedArgument(actual, label));
    if (missingNamedArgument) {
      return true;
    }
  }
  const targetHasNamedArguments = hasNamedArgumentSyntax(target);
  const actualHasNamedArguments = hasNamedArgumentSyntax(actual);
  if (targetHasNamedArguments !== actualHasNamedArguments) {
    return true;
  }
  const targetArguments = parseTrailingArguments(target);
  const actualArguments = parseTrailingArguments(actual);
  if (targetArguments && actualArguments) {
    const targetPositionalCount = targetArguments.positionalArgs.length;
    const actualPositionalCount = actualArguments.positionalArgs.length;
    const targetNamedCount = targetArguments.namedArgs.length;
    const actualNamedCount = actualArguments.namedArgs.length;

    if (targetPositionalCount > actualPositionalCount) {
      return true;
    }
    if (targetNamedCount === 0 && targetPositionalCount > 0 && actualNamedCount > 0) {
      return true;
    }
    if (targetNamedCount === 0 && actualNamedCount === 0 && actualPositionalCount > targetPositionalCount) {
      return true;
    }
    if (
      targetNamedCount === 0
      && actualNamedCount === 0
      && targetPositionalCount > 1
      && targetPositionalCount === actualPositionalCount
      && hasPositionalArgumentOrderDrift(targetArguments.positionalArgs, actualArguments.positionalArgs)
    ) {
      return true;
    }
  }

  if (target.includes('.') && !actual.includes('.')) {
    return true;
  }

  const targetStringLiterals = extractStringLiterals(target);
  if (targetStringLiterals.length > 0) {
    const outputStringLiterals = extractStringLiterals(actual);
    if (outputStringLiterals.length === 0) {
      return true;
    }
    const outputSet = new Set(outputStringLiterals);
    const hasMatchingStringLiteral = targetStringLiterals.some((value) => outputSet.has(value));
    if (!hasMatchingStringLiteral) {
      return true;
    }
  }

  return false;
}

function extractIdentifierTokens(value: string): string[] {
  return value.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) ?? [];
}

function extractMemberPaths(value: string): string[] {
  return value.match(/\b[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+\b/g) ?? [];
}

function extractNamedArgumentLabels(value: string): string[] {
  const matches = value.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*=/g);
  return Array.from(matches, (match) => match[1] ?? '').filter((label) => label.length > 0);
}

function hasNamedArgumentSyntax(value: string): boolean {
  return /\b[A-Za-z_][A-Za-z0-9_]*\s*=/.test(value);
}

function hasDelimiterSensitiveStringLiterals(values: string[]): boolean {
  return values.some((literal) => /,\s|:\s|\)\s|]\s/.test(literal));
}

function inferTargetArgForm(targetOutput: string): 'positional' | 'named' | 'mixed' | 'unknown' {
  const parts = parseTrailingArgumentList(targetOutput);
  if (!parts) {
    return 'unknown';
  }
  if (parts.namedCount > 0 && parts.positionalCount > 0) {
    return 'mixed';
  }
  if (parts.namedCount > 0) {
    return 'named';
  }
  if (parts.positionalCount > 0) {
    return 'positional';
  }
  return 'unknown';
}

function parseTrailingArgumentList(value: string): { positionalCount: number; namedCount: number } | undefined {
  const parsed = parseTrailingArguments(value);
  if (!parsed) {
    return undefined;
  }
  return {
    positionalCount: parsed.positionalArgs.length,
    namedCount: parsed.namedArgs.length,
  };
}

interface ParsedTrailingArguments {
  parts: string[];
  positionalArgs: string[];
  namedArgs: Array<{ label: string; value: string }>;
}

function parseTrailingArguments(value: string): ParsedTrailingArguments | undefined {
  const closeParen = value.indexOf(')');
  if (closeParen < 0) {
    return undefined;
  }
  const argumentText = value.slice(0, closeParen).trim();
  if (!argumentText) {
    return { parts: [], positionalArgs: [], namedArgs: [] };
  }
  const parts = splitTopLevelByComma(argumentText);
  if (parts.length === 0) {
    return undefined;
  }
  const positionalArgs: string[] = [];
  const namedArgs: Array<{ label: string; value: string }> = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }
    const namedMatch = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/.exec(trimmed);
    if (namedMatch) {
      namedArgs.push({
        label: namedMatch[1],
        value: namedMatch[2].trim(),
      });
      continue;
    }
    positionalArgs.push(trimmed);
  }
  return {
    parts,
    positionalArgs,
    namedArgs,
  };
}

function hasPositionalArgumentOrderDrift(targetArgs: string[], outputArgs: string[]): boolean {
  if (targetArgs.length !== outputArgs.length || targetArgs.length <= 1) {
    return false;
  }
  const normalize = (value: string): string => value.replace(/\s+/g, '').trim();
  const targetNormalized = targetArgs.map(normalize);
  const outputNormalized = outputArgs.map(normalize);
  if (targetNormalized.join('|') === outputNormalized.join('|')) {
    return false;
  }
  const targetSorted = [...targetNormalized].sort();
  const outputSorted = [...outputNormalized].sort();
  for (let index = 0; index < targetSorted.length; index += 1) {
    if (targetSorted[index] !== outputSorted[index]) {
      return false;
    }
  }
  return true;
}

function splitTopLevelByComma(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let escapeNext = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (escapeNext) {
      current += char;
      escapeNext = false;
      continue;
    }

    if (char === '\\') {
      current += char;
      escapeNext = true;
      continue;
    }

    if (inSingle) {
      current += char;
      if (char === '\'') {
        inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      current += char;
      if (char === '"') {
        inDouble = false;
      }
      continue;
    }
    if (inTemplate) {
      current += char;
      if (char === '`') {
        inTemplate = false;
      }
      continue;
    }

    if (char === '\'') {
      inSingle = true;
      current += char;
      continue;
    }
    if (char === '"') {
      inDouble = true;
      current += char;
      continue;
    }
    if (char === '`') {
      inTemplate = true;
      current += char;
      continue;
    }

    if (char === '(') {
      parenDepth += 1;
      current += char;
      continue;
    }
    if (char === ')') {
      parenDepth = Math.max(0, parenDepth - 1);
      current += char;
      continue;
    }
    if (char === '[') {
      bracketDepth += 1;
      current += char;
      continue;
    }
    if (char === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1);
      current += char;
      continue;
    }
    if (char === '{') {
      braceDepth += 1;
      current += char;
      continue;
    }
    if (char === '}') {
      braceDepth = Math.max(0, braceDepth - 1);
      current += char;
      continue;
    }

    if (char === ',' && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      const token = current.trim();
      if (token.length > 0) {
        parts.push(token);
      }
      current = '';
      continue;
    }

    current += char;
  }

  const trailing = current.trim();
  if (trailing.length > 0) {
    parts.push(trailing);
  }
  return parts;
}

function extractStringLiterals(value: string): string[] {
  const matches = value.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g);
  return Array.from(matches, (match) => (match[1] ?? match[2] ?? match[3] ?? ''))
    .filter((literal) => literal.length > 0);
}

function containsWord(value: string, token: string): boolean {
  return new RegExp(`\\b${escapeRegExp(token)}\\b`).test(value);
}

function containsNamedArgument(value: string, label: string): boolean {
  return new RegExp(`\\b${escapeRegExp(label)}\\s*=`).test(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function isIdentifierLike(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function isMemberPathLike(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(value);
}

function isQuotedLiteralLike(value: string): boolean {
  return /^".*"$/.test(value) || /^'.*'$/.test(value) || /^`.*`$/.test(value);
}

function hasIdentifierSuffixInflation(target: string, actual: string): boolean {
  if (!isIdentifierLike(target) && !isMemberPathLike(target)) {
    return false;
  }
  if (!actual.startsWith(target) || actual.length <= target.length) {
    return false;
  }

  const nextChar = actual[target.length];
  return nextChar === '[' || nextChar === '(' || nextChar === '.' || nextChar === ':';
}
