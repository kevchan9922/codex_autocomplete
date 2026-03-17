import {
  classifyGenericBlankLinePlaceholder,
  isBlankLineAtCursor,
  looksLikeBlankLineArgumentCarryover,
  looksLikeBlankLineCarryoverFragment,
  looksLikeBlankLineMemberSuffixCarryover,
} from './blankLineHeuristics';
import {
  getStructuralCursorLinePrefix,
  isBlankLineStructuralContinuation,
} from './blankLineContinuation';

export interface LanguagePostProcessorInput {
  suggestion: string;
  prefix: string;
  suffix: string;
  linePrefix?: string;
  lineSuffix?: string;
  languageId: string;
}

export type LanguagePostProcessor = (input: LanguagePostProcessorInput) => string;

export interface LanguagePostProcessorResult {
  suggestion: string;
  repairReasons?: string[];
}

const DEFAULT_POST_PROCESSORS: LanguagePostProcessor[] = [
  stripInvisibleFormattingArtifacts,
  dropFenceOnlySuggestion,
  repairPythonSplitlinesSuggestion,
  repairPythonSplitIndexEscapedNoise,
  repairSplitIndexDelimiterQuoteDuplication,
  repairSplitIndexDelimiterParenSpacing,
  repairPythonSplitIndexTruncation,
  repairInterpolationLiteralClosers,
  // dropInterpolationCloserCarryoverNoise,
  repairMissingOpeningQuoteLiteralFragment,
  dropGenericBlankLinePlaceholder,
  dropBlankLineShortIdentifierCarryover,
  dropBlankLineCarryoverFragment,
  dropBlankLineArgumentCarryover,
  // dropBlankLineMemberSuffixCarryover,
  repairMissingCallCloseParen,
  repairRepeatedMethodChainSuffix,
  repairTypeScriptSplitIndexEscapedNoise,
  repairRustVectorClosureSemicolon,
  trimTypeScriptLikeOptionalClosureSemicolon,
  repairSafeStatementSemicolon,
  trimTypeScriptMinimalInvocationSemicolon,
];

const INVISIBLE_FORMATTING_CHARACTERS = /[\u200B-\u200D\u2060\uFEFF]/g;
const HAS_INVISIBLE_FORMATTING_CHARACTERS = /[\u200B-\u200D\u2060\uFEFF]/;

export function applyLanguagePostProcessors(
  input: LanguagePostProcessorInput,
  postProcessors: LanguagePostProcessor[] = DEFAULT_POST_PROCESSORS,
): LanguagePostProcessorResult {
  let suggestion = input.suggestion;
  const repairReasons: string[] = [];

  for (const postProcessor of postProcessors) {
    const nextSuggestion = postProcessor({ ...input, suggestion });
    if (nextSuggestion !== suggestion) {
      repairReasons.push(postProcessor.name || 'anonymousPostProcessor');
      suggestion = nextSuggestion;
    }
  }

  return repairReasons.length > 0
    ? { suggestion, repairReasons }
    : { suggestion };
}

function stripInvisibleFormattingArtifacts(input: LanguagePostProcessorInput): string {
  if (!HAS_INVISIBLE_FORMATTING_CHARACTERS.test(input.suggestion)) {
    return input.suggestion;
  }

  return input.suggestion.replace(INVISIBLE_FORMATTING_CHARACTERS, '');
}

function dropFenceOnlySuggestion(input: LanguagePostProcessorInput): string {
  if (!isCodeLanguage(input.languageId)) {
    return input.suggestion;
  }

  const compact = compactSuggestion(input.suggestion);
  if (!compact) {
    return input.suggestion;
  }

  const isSingleFence = /^(```|~~~)[A-Za-z0-9_+-]*$/.test(compact);
  const isOpenCloseFenceOnly = /^((```|~~~)[A-Za-z0-9_+-]*)(```|~~~)$/.test(compact);
  if (!isSingleFence && !isOpenCloseFenceOnly) {
    return input.suggestion;
  }

  return withTrimmedReplacement(input.suggestion, '');
}

function compactSuggestion(value: string): string {
  return value
    .replace(INVISIBLE_FORMATTING_CHARACTERS, '')
    .replace(/\s+/g, '');
}

function repairPythonSplitlinesSuggestion(input: LanguagePostProcessorInput): string {
  if (input.languageId !== 'python' || !input.suggestion.trim()) {
    return input.suggestion;
  }

  const linePrefix = getStructuralCursorLinePrefix(input.prefix, input.linePrefix);
  const lineSuffix = input.suffix.split(/\r?\n/)[0] ?? '';
  const isReturnSplitlines = (line: string): boolean =>
    /^\s*return\b/.test(line) && /\.splitlines\(\s*$/.test(line);
  if (!isReturnSplitlines(linePrefix) && !isReturnSplitlines(lineSuffix)) {
    return input.suggestion;
  }

  const returnType = findPythonEnclosingReturnType(input.prefix);
  if (returnType !== 'str') {
    return input.suggestion;
  }

  const trimmed = input.suggestion.trim();
  if (trimmed === ')' || trimmed === '))' || /^\(+\)+$/.test(trimmed)) {
    return input.suggestion.replace(trimmed, ')[0]');
  }

  if (/^\[\s*\d+\s*]/.test(trimmed)) {
    return input.suggestion.replace(trimmed, `)${trimmed}`);
  }

  if (/^\(\)\)/.test(trimmed)) {
    return input.suggestion.replace(trimmed, trimmed.replace(/^\(\)\)/, ')[0]'));
  }

  return input.suggestion;
}

function repairPythonSplitIndexEscapedNoise(input: LanguagePostProcessorInput): string {
  if (input.languageId !== 'python') {
    return input.suggestion;
  }

  const trimmed = input.suggestion.trim();
  if (!trimmed || trimmed.includes('\n')) {
    return input.suggestion;
  }

  const linePrefix = getStructuralCursorLinePrefix(input.prefix, input.linePrefix);
  if (!/\.split\(\s*$/.test(linePrefix)) {
    return input.suggestion;
  }

  let repaired = trimmed;
  if (repaired.includes('\\"')) {
    repaired = repaired.replace(/\\"/g, '"');
  }

  if (/^".*"\)\[[^\]]+]"$/.test(repaired)) {
    repaired = repaired.slice(0, -1);
  }

  if (repaired === trimmed) {
    return input.suggestion;
  }

  return withTrimmedReplacement(input.suggestion, repaired);
}

function repairSplitIndexDelimiterQuoteDuplication(input: LanguagePostProcessorInput): string {
  if (!isSplitIndexLanguage(input.languageId)) {
    return input.suggestion;
  }

  const trimmed = input.suggestion.trim();
  if (!trimmed || trimmed.includes('\n')) {
    return input.suggestion;
  }

  const linePrefix = getStructuralCursorLinePrefix(input.prefix, input.linePrefix);
  if (!/\.split\(\s*$/.test(linePrefix)) {
    return input.suggestion;
  }

  const duplicatedQuoteMatch =
    /^(['"`])((?:\\.|(?!\1).)+)\1\1(\)\[[^\]]+\](?:;)?$)/.exec(trimmed);
  if (!duplicatedQuoteMatch) {
    return input.suggestion;
  }

  const [, quote, literalBody, tail] = duplicatedQuoteMatch;
  return withTrimmedReplacement(input.suggestion, `${quote}${literalBody}${quote}${tail}`);
}

function repairSplitIndexDelimiterParenSpacing(input: LanguagePostProcessorInput): string {
  if (!isSplitIndexLanguage(input.languageId)) {
    return input.suggestion;
  }

  const trimmed = input.suggestion.trim();
  if (!trimmed || trimmed.includes('\n')) {
    return input.suggestion;
  }

  const linePrefix = getStructuralCursorLinePrefix(input.prefix, input.linePrefix);
  if (!/\.split\(\s*$/.test(linePrefix)) {
    return input.suggestion;
  }

  const spacedParenMatch =
    /^((['"`])(?:\\.|(?!\2).)*\2)\s+(?:\2)?(\)\[[^\]]+\](?:;)?$)/.exec(trimmed);
  if (!spacedParenMatch) {
    return input.suggestion;
  }

  const [, literal, , tail] = spacedParenMatch;
  return withTrimmedReplacement(input.suggestion, `${literal}${tail}`);
}

function repairPythonSplitIndexTruncation(input: LanguagePostProcessorInput): string {
  if (input.languageId !== 'python') {
    return input.suggestion;
  }

  const trimmed = input.suggestion.trim();
  if (!trimmed || trimmed.includes('\n')) {
    return input.suggestion;
  }

  const expected = inferPythonSplitIndexCompletion(
    input.prefix,
    getStructuralCursorLinePrefix(input.prefix, input.linePrefix),
  );
  if (!expected || trimmed === expected) {
    return input.suggestion;
  }

  const expectedMatch = /^(['"`])(.*)\1\)\[0\]$/.exec(expected);
  if (!expectedMatch) {
    return input.suggestion;
  }

  const [, quote, delimiterBody] = expectedMatch;
  const truncatedForms = new Set<string>([
    `${quote}${delimiterBody}${quote})`,
    `${quote})`,
    ')',
    '[0]',
    `${quote}${delimiterBody}${quote})[0`,
  ]);
  if (!truncatedForms.has(trimmed)) {
    return input.suggestion;
  }

  return withTrimmedReplacement(input.suggestion, expected);
}

function repairInterpolationLiteralClosers(input: LanguagePostProcessorInput): string {
  const trimmed = input.suggestion.trim();
  if (!trimmed || trimmed.includes('\n')) {
    return input.suggestion;
  }

  const linePrefix = getStructuralCursorLinePrefix(input.prefix, input.linePrefix);
  const lineSuffix = input.lineSuffix ?? (input.suffix.split(/\r?\n/)[0] ?? '');

  if (input.languageId === 'python') {
    const quote = findOpenPythonFStringQuote(linePrefix);
    if (!quote) {
      return input.suggestion;
    }

    const normalized = normalizePythonInterpolationCloser(trimmed, quote, lineSuffix);
    return normalized === trimmed
      ? input.suggestion
      : withTrimmedReplacement(input.suggestion, normalized);
  }

  if (isTypeScriptLike(input.languageId) && hasOpenTemplateInterpolation(linePrefix)) {
    const normalized = normalizeTemplateInterpolationCloser(trimmed);
    return normalized === trimmed
      ? input.suggestion
      : withTrimmedReplacement(input.suggestion, normalized);
  }

  return input.suggestion;
}

function dropInterpolationCloserCarryoverNoise(input: LanguagePostProcessorInput): string {
  const trimmed = input.suggestion.trim();
  if (!trimmed || trimmed.includes('\n')) {
    return input.suggestion;
  }
  if (!/^[\]\)}]+['"`]+$/.test(trimmed)) {
    return input.suggestion;
  }

  const linePrefix = input.prefix.split(/\r?\n/).pop() ?? '';
  const lineSuffix = (input.suffix.split(/\r?\n/)[0] ?? '').trim();
  if (!linePrefix.trim() || lineSuffix) {
    return input.suggestion;
  }

  if (input.languageId === 'python') {
    if (findOpenPythonFStringQuote(linePrefix)) {
      return input.suggestion;
    }
    return withTrimmedReplacement(input.suggestion, '');
  }

  if (isTypeScriptLike(input.languageId)) {
    if (hasOpenTemplateInterpolation(linePrefix)) {
      return input.suggestion;
    }
    return withTrimmedReplacement(input.suggestion, '');
  }

  return input.suggestion;
}

function repairMissingOpeningQuoteLiteralFragment(input: LanguagePostProcessorInput): string {
  if (input.languageId !== 'python') {
    return input.suggestion;
  }

  const trimmed = input.suggestion.trim();
  if (!trimmed || trimmed.includes('\n') || /^["'`]/.test(trimmed)) {
    return input.suggestion;
  }

  const linePrefix = getStructuralCursorLinePrefix(input.prefix, input.linePrefix);
  if (!hasUnclosedParen(linePrefix)) {
    return input.suggestion;
  }

  const nearbyStringLiterals = extractRecentStringLiterals(input.prefix);
  for (const literal of nearbyStringLiterals) {
    if (!literal || !trimmed.startsWith(literal)) {
      continue;
    }

    const remainder = trimmed.slice(literal.length);
    if (!/^["'`][)\]};,]+$/.test(remainder)) {
      continue;
    }

    return withTrimmedReplacement(input.suggestion, `${remainder[0]}${trimmed}`);
  }

  return input.suggestion;
}

function dropGenericBlankLinePlaceholder(input: LanguagePostProcessorInput): string {
  if (!isCodeLanguage(input.languageId)) {
    return input.suggestion;
  }

  if (classifyGenericBlankLinePlaceholder(
    input.linePrefix,
    input.lineSuffix,
    input.prefix,
    input.suffix,
    input.suggestion,
  ) !== 'reject') {
    return input.suggestion;
  }

  return withTrimmedReplacement(input.suggestion, '');
}

function dropBlankLineShortIdentifierCarryover(input: LanguagePostProcessorInput): string {
  if (!isCodeLanguage(input.languageId)) {
    return input.suggestion;
  }

  const trimmed = input.suggestion.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed) || trimmed.length > 3) {
    return input.suggestion;
  }

  const linePrefix = input.linePrefix ?? (input.prefix.split(/\r?\n/).pop() ?? '');
  const lineSuffix = input.lineSuffix ?? (input.suffix.split(/\r?\n/)[0] ?? '');
  if (linePrefix.trim() || lineSuffix.trim()) {
    return input.suggestion;
  }
  if (isBlankLineStructuralContinuation(input.prefix, input.linePrefix)) {
    return input.suggestion;
  }

  const beforeLines = input.prefix.split(/\r?\n/);
  const minIndex = Math.max(0, beforeLines.length - 24);
  for (let index = minIndex; index < beforeLines.length; index += 1) {
    const tokens = beforeLines[index].match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) ?? [];
    if (tokens.some((token) => token.length > trimmed.length && token.endsWith(trimmed))) {
      return withTrimmedReplacement(input.suggestion, '');
    }
  }

  return input.suggestion;
}

function dropBlankLineCarryoverFragment(input: LanguagePostProcessorInput): string {
  if (!isCodeLanguage(input.languageId)) {
    return input.suggestion;
  }

  const linePrefix = input.linePrefix ?? (input.prefix.split(/\r?\n/).pop() ?? '');
  const lineSuffix = input.lineSuffix ?? (input.suffix.split(/\r?\n/)[0] ?? '');
  if (!isBlankLineAtCursor(linePrefix, lineSuffix)) {
    return input.suggestion;
  }
  if (isBlankLineStructuralContinuation(input.prefix, input.linePrefix)) {
    return input.suggestion;
  }

  const trimmed = input.suggestion.trim();
  if (isQuotedLiteralContinuation(trimmed)) {
    return input.suggestion;
  }
  if (!looksLikeBlankLineCarryoverFragment(trimmed, input.prefix)) {
    return input.suggestion;
  }

  return withTrimmedReplacement(input.suggestion, '');
}

function isQuotedLiteralContinuation(value: string): boolean {
  return /^(["'`]).*\1(?:[)\]};,]+)?$/.test(value);
}

function dropBlankLineArgumentCarryover(input: LanguagePostProcessorInput): string {
  if (!isCodeLanguage(input.languageId)) {
    return input.suggestion;
  }

  const linePrefix = input.linePrefix ?? (input.prefix.split(/\r?\n/).pop() ?? '');
  const lineSuffix = input.lineSuffix ?? (input.suffix.split(/\r?\n/)[0] ?? '');
  if (!isBlankLineAtCursor(linePrefix, lineSuffix)) {
    return input.suggestion;
  }
  if (isBlankLineStructuralContinuation(input.prefix, input.linePrefix)) {
    return input.suggestion;
  }

  if (isQuotedLiteralContinuation(input.suggestion.trim())) {
    return input.suggestion;
  }

  if (!looksLikeBlankLineArgumentCarryover(input.suggestion)) {
    return input.suggestion;
  }

  return withTrimmedReplacement(input.suggestion, '');
}

function dropBlankLineMemberSuffixCarryover(input: LanguagePostProcessorInput): string {
  if (!isCodeLanguage(input.languageId)) {
    return input.suggestion;
  }

  const linePrefix = input.linePrefix ?? (input.prefix.split(/\r?\n/).pop() ?? '');
  const lineSuffix = input.lineSuffix ?? (input.suffix.split(/\r?\n/)[0] ?? '');
  if (!isBlankLineAtCursor(linePrefix, lineSuffix)) {
    return input.suggestion;
  }
  if (isBlankLineStructuralContinuation(input.prefix, input.linePrefix)) {
    return input.suggestion;
  }

  if (!looksLikeBlankLineMemberSuffixCarryover(input.suggestion, input.suffix)) {
    return input.suggestion;
  }

  return withTrimmedReplacement(input.suggestion, '');
}

function findPythonEnclosingReturnType(prefix: string): string | undefined {
  const lines = prefix.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    const match = /^\s*def\s+[A-Za-z_]\w*\s*\([^)]*\)\s*->\s*([^:]+)\s*:\s*$/.exec(line);
    if (match) {
      return match[1].trim();
    }
  }
  return undefined;
}

function repairMissingCallCloseParen(input: LanguagePostProcessorInput): string {
  if (!isParenCloserLanguage(input.languageId)) {
    return input.suggestion;
  }

  const trimmed = input.suggestion.trim();
  if (!trimmed || trimmed.includes('\n')) {
    return input.suggestion;
  }

  const linePrefix = getStructuralCursorLinePrefix(input.prefix, input.linePrefix);
  const lineSuffix = (input.suffix.split(/\r?\n/)[0] ?? '').trimStart();
  if (!hasUnclosedParen(linePrefix) || lineSuffix.startsWith(')')) {
    return input.suggestion;
  }

  const hasTrailingSemicolon = trimmed.endsWith(';');
  const core = hasTrailingSemicolon ? trimmed.slice(0, -1).trimEnd() : trimmed;
  if (!core || core.includes(')') || !endsWithArgumentLikeToken(core)) {
    return input.suggestion;
  }

  const repaired = `${core})${hasTrailingSemicolon ? ';' : ''}`;
  return withTrimmedReplacement(input.suggestion, repaired);
}

function trimTypeScriptLikeOptionalClosureSemicolon(input: LanguagePostProcessorInput): string {
  if (!isTypeScriptLike(input.languageId)) {
    return input.suggestion;
  }

  const trimmed = input.suggestion.trim();
  if (trimmed !== ');') {
    return input.suggestion;
  }

  const linePrefix = input.prefix.split(/\r?\n/).pop() ?? '';
  if (!hasUnclosedParen(linePrefix) || !hasExistingArgumentText(linePrefix)) {
    return input.suggestion;
  }

  return withTrimmedReplacement(input.suggestion, ')');
}

function repairSafeStatementSemicolon(input: LanguagePostProcessorInput): string {
  if (!isSemicolonLanguage(input.languageId)) {
    return input.suggestion;
  }

  const trimmed = input.suggestion.trim();
  if (!trimmed || trimmed.includes('\n') || trimmed.endsWith(';')) {
    return input.suggestion;
  }
  if (trimmed === ')' || trimmed === ']' || trimmed === '}' || trimmed === ');') {
    return input.suggestion;
  }
  if (!/[)\]}]$/.test(trimmed)) {
    return input.suggestion;
  }

  const lineSuffix = (input.suffix.split(/\r?\n/)[0] ?? '').trimStart();
  if (lineSuffix.startsWith(';')) {
    return input.suggestion;
  }

  const linePrefix = input.prefix.split(/\r?\n/).pop() ?? '';
  if (!looksLikeStatementContext(linePrefix)) {
    return input.suggestion;
  }

  if (isTypeScriptLike(input.languageId)) {
    const hasCallInProgress = hasUnclosedParen(linePrefix);
    const memberContinuation = /\.[A-Za-z_][A-Za-z0-9_]*$/.test(linePrefix.trim());
    if (!hasCallInProgress && !memberContinuation) {
      return input.suggestion;
    }
    if (
      input.languageId === 'typescript'
      && !hasCallInProgress
      && memberContinuation
      && /^\s*return\b/.test(linePrefix)
    ) {
      return input.suggestion;
    }
    // Keep template interpolation literal closures minimal.
    if (!hasCallInProgress && hasOpenTemplateInterpolation(linePrefix) && /^}`/.test(trimmed)) {
      return input.suggestion;
    }
    // Keep minimal-suffix call invocation cases semicolon-free when no call is in progress.
    if (!hasCallInProgress && /^\(/.test(trimmed)) {
      return input.suggestion;
    }
  }

  return withTrimmedReplacement(input.suggestion, `${trimmed};`);
}

function trimTypeScriptMinimalInvocationSemicolon(input: LanguagePostProcessorInput): string {
  if (input.languageId !== 'typescript') {
    return input.suggestion;
  }

  const trimmed = input.suggestion.trim();
  if (!/^\([^()\n]+\);$/.test(trimmed)) {
    return input.suggestion;
  }

  const linePrefix = input.prefix.split(/\r?\n/).pop() ?? '';
  if (hasUnclosedParen(linePrefix)) {
    return input.suggestion;
  }

  const prefixTail = linePrefix.trim();
  if (!/[A-Za-z_$][A-Za-z0-9_$.]*$/.test(prefixTail)) {
    return input.suggestion;
  }

  return withTrimmedReplacement(input.suggestion, trimmed.slice(0, -1));
}

function hasUnclosedParen(value: string): boolean {
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
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
    if (inTemplate) {
      if (char === '`') {
        inTemplate = false;
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
    if (char === '`') {
      inTemplate = true;
      continue;
    }
    if (char === '(') {
      depth += 1;
      continue;
    }
    if (char === ')' && depth > 0) {
      depth -= 1;
    }
  }
  return depth > 0;
}

function hasExistingArgumentText(linePrefix: string): boolean {
  const openParen = linePrefix.lastIndexOf('(');
  if (openParen < 0) {
    return false;
  }
  const tail = linePrefix.slice(openParen + 1).trimEnd();
  return /[A-Za-z0-9_'"`\]\)]$/.test(tail);
}

function findOpenPythonFStringQuote(linePrefix: string): '"' | '\'' | undefined {
  const lastDouble = linePrefix.lastIndexOf('f"');
  const lastSingle = linePrefix.lastIndexOf("f'");
  const start = Math.max(lastDouble, lastSingle);
  if (start < 0) {
    return undefined;
  }

  const quote = linePrefix[start + 1] as '"' | '\'';
  const tail = linePrefix.slice(start + 2);
  if (!tail.includes('{')) {
    return undefined;
  }

  if (tail.lastIndexOf('{') <= tail.lastIndexOf('}')) {
    return undefined;
  }

  return quote;
}

function normalizePythonInterpolationCloser(
  value: string,
  quote: '"' | '\'',
  lineSuffix: string,
): string {
  const withoutExtraClosers = value.replace(/^[\]\)]+(?=})/, '');
  if (!withoutExtraClosers.startsWith('}')) {
    return value;
  }

  const afterBrace = withoutExtraClosers.slice(1);
  if (!afterBrace) {
    return lineSuffix.trimStart().startsWith(quote) ? value : `}${quote}`;
  }
  if (!afterBrace.startsWith(quote)) {
    return value;
  }

  let index = 0;
  while (index < afterBrace.length && afterBrace[index] === quote) {
    index += 1;
  }

  return `}${quote}${afterBrace.slice(index)}`;
}

function hasOpenTemplateInterpolation(linePrefix: string): boolean {
  return /`[^`]*\$\{[^}]*$/.test(linePrefix);
}

function normalizeTemplateInterpolationCloser(value: string): string {
  if (!/^}`+;?$/.test(value)) {
    return value;
  }
  return '}`';
}

function repairRepeatedMethodChainSuffix(input: LanguagePostProcessorInput): string {
  if (input.languageId !== 'csharp') {
    return input.suggestion;
  }

  const trimmed = input.suggestion.trim();
  if (!trimmed || trimmed.includes('\n')) {
    return input.suggestion;
  }

  const match = /^([A-Za-z_][A-Za-z0-9_]*)\(\);\1([A-Za-z_][A-Za-z0-9_]*)\(\);$/.exec(trimmed);
  if (!match) {
    return input.suggestion;
  }

  const [, duplicatePrefix, remainingName] = match;
  const linePrefix = input.prefix.split(/\r?\n/).pop()?.trimEnd() ?? '';
  if (!linePrefix.includes('.') && !/\breturn\b/.test(linePrefix)) {
    return input.suggestion;
  }

  return withTrimmedReplacement(input.suggestion, `${duplicatePrefix}${remainingName}();`);
}

function repairTypeScriptSplitIndexEscapedNoise(input: LanguagePostProcessorInput): string {
  if (!isTypeScriptLike(input.languageId)) {
    return input.suggestion;
  }

  const trimmed = input.suggestion.trim();
  if (!trimmed || trimmed.includes('\n')) {
    return input.suggestion;
  }

  const linePrefix = getStructuralCursorLinePrefix(input.prefix, input.linePrefix);
  if (!/\.split\(\s*$/.test(linePrefix)) {
    return input.suggestion;
  }

  let repaired = trimmed;
  if (repaired.includes('\\"')) {
    repaired = repaired.replace(/\\"/g, '"');
  }

  // Strip trailing quote from quoted-noise forms like `", ")[0];"`.
  if (/^".*"\)\[[^\]]+];"$/.test(repaired)) {
    repaired = repaired.slice(0, -1);
  }

  if (repaired === trimmed) {
    return input.suggestion;
  }

  return withTrimmedReplacement(input.suggestion, repaired);
}

function repairRustVectorClosureSemicolon(input: LanguagePostProcessorInput): string {
  if (input.languageId !== 'rust') {
    return input.suggestion;
  }

  const trimmed = input.suggestion.trim();
  if (trimmed !== ']') {
    return input.suggestion;
  }

  const linePrefix = input.prefix.split(/\r?\n/).pop() ?? '';
  const lineSuffix = (input.suffix.split(/\r?\n/)[0] ?? '').trimStart();
  if (lineSuffix.startsWith(';')) {
    return input.suggestion;
  }

  if (!/\bvec!\s*\[[^\]]*$/.test(linePrefix)) {
    return input.suggestion;
  }
  if (!/\blet\b/.test(linePrefix) && !linePrefix.includes('=')) {
    return input.suggestion;
  }

  return withTrimmedReplacement(input.suggestion, '];');
}

function endsWithArgumentLikeToken(value: string): boolean {
  return /[A-Za-z0-9_'"`\]\}]$/.test(value);
}

function extractRecentStringLiterals(prefix: string): string[] {
  const lines = prefix.split(/\r?\n/);
  const literals = new Set<string>();
  const minIndex = Math.max(0, lines.length - 40);
  const stringPattern = /(["'])(.*?)(?<!\\)\1/g;

  for (let index = minIndex; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    for (const match of line.matchAll(stringPattern)) {
      const literal = match[2]?.trim();
      if (literal) {
        literals.add(literal);
      }
    }
  }

  return [...literals];
}

function looksLikeStatementContext(linePrefix: string): boolean {
  const trimmed = linePrefix.trim();
  if (!trimmed) {
    return false;
  }
  return /^(?:return|const|let|var|final|public|private|protected|static)\b/.test(trimmed)
    || trimmed.includes('=')
    || /^let\b/.test(trimmed);
}

function withTrimmedReplacement(value: string, replacement: string): string {
  const leading = value.match(/^\s*/)?.[0] ?? '';
  const trailing = value.match(/\s*$/)?.[0] ?? '';
  return `${leading}${replacement}${trailing}`;
}

function isParenCloserLanguage(languageId: string): boolean {
  return languageId === 'python'
    || languageId === 'javascript'
    || languageId === 'typescript'
    || languageId === 'java'
    || languageId === 'csharp'
    || languageId === 'go'
    || languageId === 'rust';
}

function isSplitIndexLanguage(languageId: string): boolean {
  return languageId === 'python' || isTypeScriptLike(languageId);
}

function isSemicolonLanguage(languageId: string): boolean {
  return languageId === 'javascript'
    || languageId === 'typescript'
    || languageId === 'java'
    || languageId === 'csharp'
    || languageId === 'rust';
}

function isTypeScriptLike(languageId: string): boolean {
  return languageId === 'javascript' || languageId === 'typescript';
}

function isCodeLanguage(languageId: string): boolean {
  return languageId !== 'markdown' && languageId !== 'plaintext';
}

function inferPythonSplitIndexCompletion(
  prefix: string,
  linePrefixOverride?: string,
): string | undefined {
  const linePrefix = linePrefixOverride ?? (prefix.split(/\r?\n/).pop() ?? '');
  if (!/\.split\(\s*$/.test(linePrefix)) {
    return undefined;
  }

  const beforeLines = prefix.split(/\r?\n/);
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
