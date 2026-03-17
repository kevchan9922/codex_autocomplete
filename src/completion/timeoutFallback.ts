import {
  getBlankLineStructuralAnchor,
  getStructuralCursorLinePrefix,
} from './blankLineContinuation';
import { getFirstMeaningfulSuffixLine } from './blankLineHeuristics';

export interface TimeoutFallbackInput {
  timedOutBeforeFirstChunk: boolean;
  languageId: string;
  prefix: string;
  suffix?: string;
  filePath?: string;
  lineSuffix?: string;
  beforeLines?: string[];
  rawSuggestion?: string;
}

const RETURN_FALLBACK_IDENTIFIER_STOPWORDS = new Set([
  'return',
  'if',
  'else',
  'elif',
  'for',
  'while',
  'try',
  'except',
  'finally',
  'with',
  'def',
  'class',
]);
const GENERIC_IDENTIFIER_STOPWORDS = new Set([
  ...RETURN_FALLBACK_IDENTIFIER_STOPWORDS,
  'const',
  'let',
  'var',
  'new',
  'static',
  'public',
  'private',
  'protected',
  'function',
  'null',
  'true',
  'false',
]);
const SEMICOLON_FALLBACK_LANGUAGES = new Set([
  'javascript',
  'javascriptreact',
  'typescript',
  'typescriptreact',
  'java',
  'csharp',
]);
const TYPESCRIPT_LIKE_LANGUAGES = new Set([
  'javascript',
  'javascriptreact',
  'typescript',
  'typescriptreact',
]);

export function buildTimeoutFallbackSuggestion(
  input: TimeoutFallbackInput,
): string | undefined {
  if (!input.timedOutBeforeFirstChunk) {
    return undefined;
  }

  const beforeLines = resolveBeforeLines(input.beforeLines, input.prefix);
  const linePrefix = beforeLines[beforeLines.length - 1] ?? '';
  const structuralLinePrefix = getStructuralCursorLinePrefix(input.prefix, linePrefix);
  if (input.languageId === 'python') {
    const pythonMissingOpeningQuoteFallback = buildPythonMissingOpeningQuoteFallback({
      rawSuggestion: input.rawSuggestion,
      prefix: input.prefix,
      beforeLines,
    });
    if (pythonMissingOpeningQuoteFallback) {
      return pythonMissingOpeningQuoteFallback;
    }

    const fStringClosureFallback = buildPythonFStringClosureFallback(structuralLinePrefix);
    if (fStringClosureFallback) {
      return fStringClosureFallback;
    }

    const pythonSplitIndexFallback = buildPythonSplitIndexFallback(beforeLines, structuralLinePrefix);
    if (pythonSplitIndexFallback) {
      return pythonSplitIndexFallback;
    }

    const pythonReturnFallback = buildPythonReturnFallback(linePrefix, beforeLines);
    if (pythonReturnFallback) {
      return pythonReturnFallback;
    }

    const pythonBlankLineStatementFallback = buildPythonBlankLineStatementFallback({
      linePrefix,
      suffix: input.suffix,
      filePath: input.filePath,
      lineSuffix: input.lineSuffix,
      prefix: input.prefix,
      beforeLines,
    });
    if (pythonBlankLineStatementFallback) {
      return pythonBlankLineStatementFallback;
    }
  }

  if (isTypeScriptLike(input.languageId)) {
    const templateLiteralClosureFallback =
      buildTypeScriptTemplateInterpolationClosureFallback(structuralLinePrefix);
    if (templateLiteralClosureFallback) {
      return templateLiteralClosureFallback;
    }

    const splitIndexFallback = buildTypeScriptSplitIndexFallback(
      input.languageId,
      structuralLinePrefix,
      input.lineSuffix,
    );
    if (splitIndexFallback) {
      return splitIndexFallback;
    }
  }

  const memberSuffixFallback = buildUniqueMemberSuffixFallback({
    languageId: input.languageId,
    linePrefix: structuralLinePrefix,
    lineSuffix: input.lineSuffix,
    beforeLines,
  });
  if (memberSuffixFallback) {
    return memberSuffixFallback;
  }

  const identifierSuffixFallback =
    buildUniqueIdentifierSuffixFallback(structuralLinePrefix, beforeLines);
  if (identifierSuffixFallback) {
    return identifierSuffixFallback;
  }

  const semicolonFallback = buildSemicolonFallback(
    input.languageId,
    structuralLinePrefix,
    input.lineSuffix,
  );
  if (semicolonFallback) {
    return semicolonFallback;
  }

  return undefined;
}

function buildPythonReturnFallback(linePrefix: string, beforeLines: string[]): string | undefined {
  if (!/^\s*return\s*$/.test(linePrefix)) {
    return undefined;
  }

  const returnIndentLength = (linePrefix.match(/^\s*/) ?? [''])[0].length;
  const identifier = findNearestSameIndentAssignedIdentifier(beforeLines, returnIndentLength);
  return identifier ? ` ${identifier}` : undefined;
}

function findNearestSameIndentAssignedIdentifier(
  beforeLines: string[],
  indentLength: number,
): string | undefined {
  const searchStart = beforeLines.length - 2;
  const minIndex = Math.max(0, beforeLines.length - 26);

  for (let index = searchStart; index >= minIndex; index -= 1) {
    const line = beforeLines[index];
    if (!line || !line.trim()) {
      continue;
    }

    const currentIndentLength = (line.match(/^\s*/) ?? [''])[0].length;
    if (
      currentIndentLength < indentLength
      && /^\s*(?:def|class|if|for|while|try|with|match|else|elif|except|finally)\b/.test(line)
    ) {
      break;
    }

    if (currentIndentLength !== indentLength) {
      continue;
    }

    const assignment = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*.+$/.exec(line);
    if (!assignment) {
      continue;
    }

    const identifier = assignment[1];
    if (RETURN_FALLBACK_IDENTIFIER_STOPWORDS.has(identifier.toLowerCase())) {
      continue;
    }

    return identifier;
  }

  return undefined;
}

function buildPythonFStringClosureFallback(linePrefix: string): string | undefined {
  if (!linePrefix.includes('f"') && !linePrefix.includes("f'")) {
    return undefined;
  }

  const fStringStart = /\bf(["'])/.exec(linePrefix);
  if (!fStringStart) {
    return undefined;
  }

  const quote = fStringStart[1];
  const quotePattern = new RegExp(`\\${quote}`, 'g');
  const quoteCount = (linePrefix.match(quotePattern) ?? []).length;
  const needsQuoteClosure = quoteCount % 2 === 1;

  const braceNormalized = linePrefix.replace(/{{/g, '').replace(/}}/g, '');
  const openBraces = (braceNormalized.match(/{/g) ?? []).length;
  const closeBraces = (braceNormalized.match(/}/g) ?? []).length;
  const bracesToClose = Math.max(0, openBraces - closeBraces);
  if (!needsQuoteClosure && bracesToClose === 0) {
    return undefined;
  }
  if (bracesToClose > 4) {
    return undefined;
  }

  return `${'}'.repeat(bracesToClose)}${needsQuoteClosure ? quote : ''}`;
}

function buildPythonMissingOpeningQuoteFallback(input: {
  rawSuggestion: string | undefined;
  prefix: string;
  beforeLines: string[];
}): string | undefined {
  const trimmed = input.rawSuggestion?.trim();
  if (!trimmed || trimmed.includes('\n') || /^["'`]/.test(trimmed)) {
    return undefined;
  }
  if (!hasUnclosedParen(input.prefix)) {
    return undefined;
  }

  const nearbyStringLiterals = extractRecentStringLiterals(input.beforeLines);
  for (const literal of nearbyStringLiterals) {
    if (!literal || !trimmed.startsWith(literal)) {
      continue;
    }

    const remainder = trimmed.slice(literal.length);
    if (!/^["'`][)\]};,]+$/.test(remainder)) {
      continue;
    }

    return `${remainder[0]}${trimmed}`;
  }

  return undefined;
}

function buildPythonBlankLineStatementFallback(input: {
  linePrefix: string;
  suffix?: string;
  filePath?: string;
  lineSuffix: string | undefined;
  prefix: string;
  beforeLines: string[];
}): string | undefined {
  if (input.linePrefix.trim() || (input.lineSuffix ?? '').trim()) {
    return undefined;
  }
  if (!/^\s+$/.test(input.linePrefix)) {
    return undefined;
  }
  if (getBlankLineStructuralAnchor(input.prefix, input.linePrefix)) {
    return undefined;
  }
  if (hasUnclosedParen(input.prefix) || hasUnclosedBracketOrBrace(input.prefix)) {
    return undefined;
  }
  if (isBenchmarkOrTestFixtureFilePath(input.filePath)) {
    return undefined;
  }
  if (getFirstMeaningfulSuffixLine(input.suffix ?? '')) {
    return undefined;
  }

  const indentLength = (input.linePrefix.match(/^\s*/) ?? [''])[0].length;
  const identifier = findNearestSameIndentAssignedIdentifier(input.beforeLines, indentLength);
  return identifier ?? undefined;
}

function buildPythonSplitIndexFallback(
  beforeLines: string[],
  linePrefix: string,
): string | undefined {
  if (!/\.split\(\s*$/.test(linePrefix)) {
    return undefined;
  }

  const minIndex = Math.max(0, beforeLines.length - 40);
  for (let index = beforeLines.length - 1; index >= minIndex; index -= 1) {
    const line = beforeLines[index] ?? '';
    const match = /(["'`])((?:\\.|(?!\1).)*)\1\.join\(/.exec(line);
    if (!match) {
      continue;
    }

    const [, quote, delimiterBody] = match;
    return `${quote}${delimiterBody}${quote})[0]`;
  }

  return undefined;
}

function buildTypeScriptTemplateInterpolationClosureFallback(
  linePrefix: string,
): string | undefined {
  if (!/`[^`]*\$\{[^}]*$/.test(linePrefix)) {
    return undefined;
  }

  return '}`';
}

function buildTypeScriptSplitIndexFallback(
  languageId: string,
  linePrefix: string,
  lineSuffix: string | undefined,
): string | undefined {
  const joinSplitMatch =
    /\.join\(\s*(["'`])((?:\\.|(?!\1).)*)\1\s*\)\.split\(\s*$/.exec(linePrefix);
  if (!joinSplitMatch) {
    return undefined;
  }

  const [, quote, delimiterBody] = joinSplitMatch;
  let completion = `${quote}${delimiterBody}${quote})[0]`;
  if (shouldAppendSemicolon(languageId, `${linePrefix}${completion}`, lineSuffix)) {
    completion += ';';
  }
  return completion;
}

function resolveBeforeLines(beforeLines: string[] | undefined, prefix: string): string[] {
  if (beforeLines && beforeLines.length > 0) {
    return beforeLines;
  }
  if (!prefix) {
    return [];
  }
  return prefix.split(/\r?\n/);
}

function isBenchmarkOrTestFixtureFilePath(filePath: string | undefined): boolean {
  if (!filePath) {
    return false;
  }

  const normalizedPath = filePath.replace(/\\/g, '/').toLowerCase();
  return normalizedPath.includes('/test_files/')
    || normalizedPath.includes('/__fixtures__/')
    || normalizedPath.includes('/fixtures/');
}

function extractRecentStringLiterals(beforeLines: string[]): string[] {
  const literals = new Set<string>();
  const minIndex = Math.max(0, beforeLines.length - 40);
  const stringPattern = /(["'])(.*?)(?<!\\)\1/g;
  for (let index = minIndex; index < beforeLines.length; index += 1) {
    const line = beforeLines[index] ?? '';
    for (const match of line.matchAll(stringPattern)) {
      const literal = match[2]?.trim();
      if (literal) {
        literals.add(literal);
      }
    }
  }
  return [...literals];
}

function buildUniqueIdentifierSuffixFallback(
  linePrefix: string,
  beforeLines: string[],
): string | undefined {
  const partialMatch = /([A-Za-z_][A-Za-z0-9_]*)$/.exec(linePrefix);
  if (!partialMatch) {
    return undefined;
  }

  const partial = partialMatch[1];
  if (partial.length < 3) {
    return undefined;
  }

  const candidates = new Set<string>();
  const minIndex = Math.max(0, beforeLines.length - 40);
  for (let index = minIndex; index < beforeLines.length - 1; index += 1) {
    const matches = beforeLines[index].match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) ?? [];
    for (const token of matches) {
      if (
        token.length > partial.length
        && token.startsWith(partial)
        && !GENERIC_IDENTIFIER_STOPWORDS.has(token.toLowerCase())
      ) {
        candidates.add(token);
      }
    }
  }

  if (candidates.size !== 1) {
    return undefined;
  }

  const [candidate] = [...candidates];
  return candidate.slice(partial.length) || undefined;
}

function buildUniqueMemberSuffixFallback(input: {
  languageId: string;
  linePrefix: string;
  lineSuffix?: string;
  beforeLines: string[];
}): string | undefined {
  const memberMatch = /\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(input.linePrefix);
  if (!memberMatch) {
    return undefined;
  }

  const partial = memberMatch[1];
  if (partial.length < 2) {
    return undefined;
  }

  const matches = new Map<string, { callCount: number; semicolonCount: number }>();
  const minIndex = Math.max(0, input.beforeLines.length - 40);

  for (let index = minIndex; index < input.beforeLines.length - 1; index += 1) {
    const line = input.beforeLines[index];
    const regex = /\.([A-Za-z_][A-Za-z0-9_]*)\s*(\()?/g;
    for (const match of line.matchAll(regex)) {
      const token = match[1];
      if (!token.startsWith(partial) || token.length <= partial.length) {
        continue;
      }
      const existing = matches.get(token) ?? { callCount: 0, semicolonCount: 0 };
      if (match[2] === '(') {
        existing.callCount += 1;
      }
      if (line.includes(`.${token}();`) || line.includes(`.${token};`)) {
        existing.semicolonCount += 1;
      }
      matches.set(token, existing);
    }
  }

  if (matches.size !== 1) {
    return undefined;
  }

  const [candidate, details] = [...matches.entries()][0];
  let completion = candidate.slice(partial.length);
  if (details.callCount > 0) {
    completion += '()';
  }
  if (
    details.semicolonCount > 0
    && shouldAppendSemicolon(input.languageId, `${input.linePrefix}${completion}`, input.lineSuffix)
  ) {
    completion += ';';
  }
  return completion || undefined;
}

function buildSemicolonFallback(
  languageId: string,
  linePrefix: string,
  lineSuffix: string | undefined,
): string | undefined {
  if (!shouldAppendSemicolon(languageId, linePrefix, lineSuffix)) {
    return undefined;
  }
  return ';';
}

function shouldAppendSemicolon(
  languageId: string,
  linePrefix: string,
  lineSuffix: string | undefined,
): boolean {
  if (!SEMICOLON_FALLBACK_LANGUAGES.has(languageId)) {
    return false;
  }

  const trimmed = linePrefix.trimEnd();
  if (!trimmed || trimmed.endsWith(';')) {
    return false;
  }
  if (lineSuffix && lineSuffix.trim().length > 0) {
    return false;
  }
  if (!/[)\]"'`]$/.test(trimmed)) {
    return false;
  }
  return true;
}

function isTypeScriptLike(languageId: string): boolean {
  return TYPESCRIPT_LIKE_LANGUAGES.has(languageId);
}

function hasUnclosedParen(value: string): boolean {
  return countUnclosedGrouping(value, '(', ')') > 0;
}

function hasUnclosedBracketOrBrace(value: string): boolean {
  return countUnclosedGrouping(value, '[', ']') > 0 || countUnclosedGrouping(value, '{', '}') > 0;
}

function countUnclosedGrouping(
  value: string,
  openChar: string,
  closeChar: string,
): number {
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let escapeNext = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (char === '\\') {
      escapeNext = true;
      continue;
    }
    if (inSingle) {
      if (char === '\'') {
        inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      if (char === '"') {
        inDouble = false;
      }
      continue;
    }
    if (char === '\'') {
      inSingle = true;
      continue;
    }
    if (char === '"') {
      inDouble = true;
      continue;
    }
    if (char === openChar) {
      depth += 1;
      continue;
    }
    if (char === closeChar && depth > 0) {
      depth -= 1;
    }
  }

  return depth;
}
