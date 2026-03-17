import { CompletionRequest } from '../api/aiProvider';

export interface NormalizedInlineRequestContext {
  prefix: string;
  suffix: string;
  linePrefix: string;
  lineSuffix: string;
  context?: string;
  beforeLines?: string[];
  afterLines?: string[];
  hash?: string;
  languageId?: string;
  filePath?: string;
  cursor?: {
    line: number;
    character: number;
  };
  truncated?: boolean;
}

export interface CompletionRequestLogMetadata {
  source?: string;
  benchmarkMode?: string;
  stage?: string;
  editorKey?: string;
  requestId?: number;
  contextHash?: string;
}

export function normalizeInlineRequestContext(
  raw: string | Partial<NormalizedInlineRequestContext>,
): NormalizedInlineRequestContext {
  if (typeof raw !== 'string') {
    return buildNormalizedContext(raw);
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return buildNormalizedContext({});
  }

  const parsed = tryParseJsonObject(trimmed);
  if (!parsed) {
    return buildNormalizedContext({});
  }

  return buildNormalizedContext(parsed);
}

export function buildCompletionRequestLogFields(
  request: Pick<
    CompletionRequest,
    | 'prefix'
    | 'suffix'
    | 'linePrefix'
    | 'lineSuffix'
    | 'languageId'
    | 'filePath'
    | 'context'
    | 'instructions'
    | 'maxOutputTokens'
    | 'serviceTier'
    | 'promptCacheKey'
    | 'promptCacheRetention'
    | 'interactionMode'
  >,
  metadata: CompletionRequestLogMetadata = {},
): Array<[string, string | number]> {
  const fields: Array<[string, string | number]> = [];

  appendField(fields, 'source', metadata.source);
  appendField(fields, 'benchmark_mode', metadata.benchmarkMode);
  appendField(fields, 'stage', metadata.stage);
  appendField(fields, 'interaction_mode', request.interactionMode);
  appendField(fields, 'editor', metadata.editorKey);
  appendField(fields, 'request_id', metadata.requestId);
  appendField(fields, 'context_hash', metadata.contextHash);
  fields.push(['language_id', request.languageId]);
  fields.push(['file_path', request.filePath]);
  fields.push(['prefix_chars', request.prefix.length]);
  fields.push(['suffix_chars', request.suffix.length]);
  fields.push(['line_prefix', request.linePrefix ?? deriveLinePrefix(request.prefix)]);
  fields.push(['line_suffix', request.lineSuffix ?? deriveLineSuffix(request.suffix)]);
  fields.push(['extra_context_chars', request.context?.length ?? 0]);
  fields.push(['instructions_chars', request.instructions?.length ?? 0]);
  appendField(fields, 'max_output_tokens', request.maxOutputTokens);
  appendField(fields, 'service_tier', request.serviceTier);
  appendField(fields, 'prompt_cache_key', request.promptCacheKey);
  appendField(fields, 'prompt_cache_retention', request.promptCacheRetention);

  return fields;
}

export function formatCompletionRequestLogFields(
  fields: Array<[string, string | number]>,
): string {
  return fields
    .map(([key, value]) => `${key}=${formatLogValue(value)}`)
    .join(' ');
}

function buildNormalizedContext(
  raw: Partial<NormalizedInlineRequestContext>,
): NormalizedInlineRequestContext {
  const prefix = typeof raw.prefix === 'string' ? raw.prefix : '';
  const suffix = typeof raw.suffix === 'string' ? raw.suffix : '';
  const beforeLines = normalizeStringArray(raw.beforeLines);
  const afterLines = normalizeStringArray(raw.afterLines);

  return {
    prefix,
    suffix,
    linePrefix: typeof raw.linePrefix === 'string' ? raw.linePrefix : deriveLinePrefix(prefix),
    lineSuffix: typeof raw.lineSuffix === 'string' ? raw.lineSuffix : deriveLineSuffix(suffix),
    context: typeof raw.context === 'string' && raw.context.length > 0 ? raw.context : undefined,
    beforeLines,
    afterLines,
    hash: typeof raw.hash === 'string' ? raw.hash : undefined,
    languageId: typeof raw.languageId === 'string' ? raw.languageId : undefined,
    filePath: typeof raw.filePath === 'string' ? raw.filePath : undefined,
    cursor: normalizeCursor(raw.cursor),
    truncated: typeof raw.truncated === 'boolean' ? raw.truncated : undefined,
  };
}

function deriveLinePrefix(prefix: string): string {
  const lines = prefix.split(/\r?\n/);
  return lines[lines.length - 1] ?? '';
}

function deriveLineSuffix(suffix: string): string {
  const lines = suffix.split(/\r?\n/);
  return lines[0] ?? '';
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const strings = value.filter((entry): entry is string => typeof entry === 'string');
  return strings.length > 0 ? strings : undefined;
}

function normalizeCursor(value: unknown): { line: number; character: number } | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const line = value.line;
  const character = value.character;
  if (!Number.isInteger(line) || !Number.isInteger(character)) {
    return undefined;
  }
  return {
    line: Number(line),
    character: Number(character),
  };
}

function appendField(
  fields: Array<[string, string | number]>,
  key: string,
  value: string | number | undefined,
): void {
  if (value === undefined) {
    return;
  }
  fields.push([key, value]);
}

function formatLogValue(value: string | number): string {
  return typeof value === 'number' ? String(value) : JSON.stringify(value);
}

function tryParseJsonObject(value: string): Partial<NormalizedInlineRequestContext> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed as Partial<NormalizedInlineRequestContext> : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
