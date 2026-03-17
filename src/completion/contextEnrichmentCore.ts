import { buildCompletionContext, ContextBuilderConfig } from './contextBuilder';

export interface RecentContextEntry {
  filePath: string;
  languageId: string;
  prefix: string;
  suffix: string;
  selection: string;
  timestamp: number;
}

export interface RecencyStoreOptions {
  maxEntries?: number;
  contextConfig?: ContextBuilderConfig;
}

interface RecentContextInput {
  filePath: string;
  languageId: string;
  prefix: string;
  suffix: string;
  selection?: string;
}

export interface ExtraContextOptions {
  maxImportLines?: number;
  maxImports?: number;
  maxRecentFiles?: number;
  maxChars?: number;
  includeCurrentSymbol?: boolean;
  symbolLookupTimeoutMs?: number;
}

export interface ExtraContextFromTextInput {
  text: string;
  recentEntries: RecentContextEntry[];
  currentSymbol?: string;
  options?: ExtraContextOptions;
}

const DEFAULT_RECENT_CONFIG: ContextBuilderConfig = {
  maxBeforeLines: 60,
  maxAfterLines: 12,
  maxContextChars: 1200,
  maxFileLines: 5000,
};

export const SYMBOL_LOOKUP_TIMEOUT_MS = 120;

const DEFAULT_EXTRA_OPTIONS: Required<ExtraContextOptions> = {
  maxImportLines: 80,
  maxImports: 10,
  maxRecentFiles: 1,
  maxChars: 800,
  includeCurrentSymbol: true,
  symbolLookupTimeoutMs: SYMBOL_LOOKUP_TIMEOUT_MS,
};

export class RecencyContextStore {
  private readonly maxEntries: number;
  private readonly contextConfig: ContextBuilderConfig;
  private entries: RecentContextEntry[] = [];

  constructor(options: RecencyStoreOptions = {}) {
    this.maxEntries = options.maxEntries ?? 4;
    this.contextConfig = options.contextConfig ?? DEFAULT_RECENT_CONFIG;
  }

  recordSnapshot(snapshot: { text: string; languageId: string; filePath: string }, cursor: {
    line: number;
    character: number;
  }): void {
    const result = buildCompletionContext(snapshot, cursor, this.contextConfig);
    if (result.skip) {
      return;
    }

    this.recordContext({
      filePath: snapshot.filePath,
      languageId: snapshot.languageId,
      prefix: result.context.prefix,
      suffix: result.context.suffix,
      selection: result.context.selection,
    });
  }

  recordContext(context: RecentContextInput): void {
    const entry: RecentContextEntry = {
      filePath: context.filePath,
      languageId: context.languageId,
      prefix: context.prefix,
      suffix: context.suffix,
      selection: context.selection ?? '',
      timestamp: Date.now(),
    };
    this.upsertEntry(entry);
  }

  getRecentEntries(currentFilePath: string): RecentContextEntry[] {
    return this.entries.filter((entry) => entry.filePath !== currentFilePath);
  }

  private upsertEntry(entry: RecentContextEntry): void {
    this.entries = this.entries.filter((item) => item.filePath !== entry.filePath);
    this.entries.unshift(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(0, this.maxEntries);
    }
  }
}

export function buildExtraContextFromText(input: ExtraContextFromTextInput): string | undefined {
  const config = resolveExtraContextOptions(input.options);
  const sections: string[] = [];

  const imports = extractImportLines(input.text, config.maxImportLines, config.maxImports);
  if (imports.length > 0) {
    sections.push(`IMPORTS:\n${imports.join('\n')}`);
  }

  if (config.includeCurrentSymbol && input.currentSymbol) {
    sections.push(`CURRENT_SYMBOL: ${input.currentSymbol}`);
  }

  const recent = input.recentEntries.slice(0, config.maxRecentFiles);
  if (recent.length > 0) {
    sections.push(`RECENT_CONTEXT:\n${formatRecentContext(recent)}`);
  }

  if (sections.length === 0) {
    return undefined;
  }

  return truncateToMaxChars(sections.join('\n\n'), config.maxChars);
}

export function resolveExtraContextOptions(
  options: ExtraContextOptions = {},
): Required<ExtraContextOptions> {
  return { ...DEFAULT_EXTRA_OPTIONS, ...options };
}

function extractImportLines(text: string, maxLines: number, maxImports: number): string[] {
  const lines = text.split(/\r?\n/).slice(0, maxLines);
  const imports: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    if (
      /^\s*import\b/.test(line)
      || /^\s*from\b.*\bimport\b/.test(line)
      || /^\s*using\b/.test(line)
      || /^\s*#include\b/.test(line)
      || /\brequire\(/.test(line)
    ) {
      imports.push(trimmed);
    }

    if (imports.length >= maxImports) {
      break;
    }
  }

  return imports;
}

function formatRecentContext(entries: RecentContextEntry[]): string {
  return entries
    .map((entry) => {
      const fileLabel = basename(entry.filePath);
      const parts = [entry.prefix, entry.selection, entry.suffix].filter(Boolean);
      return `FILE: ${fileLabel}\n${parts.join('\n')}`;
    })
    .join('\n\n');
}

function basename(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] || filePath;
}

function truncateToMaxChars(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return value.slice(0, maxChars);
}
