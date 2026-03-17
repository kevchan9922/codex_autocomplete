import { applySlidingWindow, SlidingWindowConfig } from './slidingWindow';

export interface CursorPosition {
  line: number;
  character: number;
}

export interface ContextBuilderConfig extends SlidingWindowConfig {
  maxFileLines: number;
}

export interface DocumentSnapshot {
  text: string;
  languageId: string;
  filePath: string;
  selection?: string;
}

export interface CompletionContext {
  prefix: string;
  suffix: string;
  linePrefix: string;
  lineSuffix: string;
  selection: string;
  languageId: string;
  filePath: string;
  beforeLines: string[];
  afterLines: string[];
  cursor: CursorPosition;
  hash: string;
  truncated: boolean;
}

export type ContextBuildResult =
  | { skip: false; context: CompletionContext; lineCount: number; truncatedForFileSize?: boolean };

export const DEFAULT_CONTEXT_CONFIG: ContextBuilderConfig = {
  maxBeforeLines: 120,
  maxAfterLines: 12,
  maxContextChars: 6000,
  maxFileLines: 5000,
};

export function buildCompletionContext(
  snapshot: DocumentSnapshot,
  cursor: CursorPosition,
  config: ContextBuilderConfig = DEFAULT_CONTEXT_CONFIG,
): ContextBuildResult {
  const lines = snapshot.text.split(/\r?\n/);
  const oversizedFile = lines.length > config.maxFileLines;

  const safeCursorLine = Math.min(Math.max(cursor.line, 0), Math.max(lines.length - 1, 0));
  const currentLine = lines[safeCursorLine] ?? '';
  const safeCursorCharacter = Math.min(Math.max(cursor.character, 0), currentLine.length);
  const linePrefix = currentLine.slice(0, safeCursorCharacter);
  const lineSuffix = currentLine.slice(safeCursorCharacter);

  const window = applySlidingWindow(
    lines,
    cursor.line,
    cursor.character,
    snapshot.selection ?? '',
    config,
  );

  const context: CompletionContext = {
    prefix: window.beforeLines.join('\n'),
    suffix: window.afterLines.join('\n'),
    linePrefix,
    lineSuffix,
    selection: window.selection,
    languageId: snapshot.languageId,
    filePath: snapshot.filePath,
    beforeLines: window.beforeLines,
    afterLines: window.afterLines,
    cursor,
    truncated: window.truncated,
    hash: createContextHash({
      beforeLines: window.beforeLines,
      afterLines: window.afterLines,
      selection: window.selection,
      languageId: snapshot.languageId,
      filePath: snapshot.filePath,
      cursor,
    }),
  };

  return {
    skip: false,
    context,
    lineCount: lines.length,
    truncatedForFileSize: oversizedFile || undefined,
  };
}

interface HashInput {
  beforeLines: string[];
  afterLines: string[];
  selection: string;
  languageId: string;
  filePath: string;
  cursor: CursorPosition;
}

export function createContextHash(input: HashInput): string {
  const serialized = JSON.stringify({
    beforeLines: input.beforeLines,
    afterLines: input.afterLines,
    selection: input.selection,
    languageId: input.languageId,
    filePath: input.filePath,
    cursor: {
      line: input.cursor.line,
      character: input.cursor.character,
    },
  });

  return fnv1a(serialized);
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return (hash >>> 0).toString(16).padStart(8, '0');
}
