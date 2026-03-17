import { isBlankLineStructuralContinuation } from './blankLineContinuation';

const LEADING_STATEMENT_KEYWORDS =
  /^(?:return|pass|raise|await|yield|break|continue|import|from|const|let|var|new|throw|if|elif|else|for|while|switch|case|default|try|catch|finally|class|def|function|public|private|protected|static|async|with)\b/;

const CALL_STATEMENT =
  /^(?:[A-Za-z_$][A-Za-z0-9_$]*)(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*\s*\([^\n]*\)(?:;)?$/;
const INDEX_STATEMENT =
  /^(?:[A-Za-z_$][A-Za-z0-9_$]*)(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*\s*\[[^\n]*\](?:;)?$/;
const JSON_PROPERTY_STATEMENT =
  /^"(?:[^"\\]|\\.)+"\s*:\s*.+,?$/;
const TYPED_MEMBER_DECLARATION_STATEMENT =
  /^(?:pub\s+)?[A-Za-z_$][A-Za-z0-9_$]*\s*:\s*[A-Za-z_$][A-Za-z0-9_$<>, ?:[\]]*(?:\s*=\s*[^,;]+)?[,;]?$/;
const GO_STRUCT_FIELD_DECLARATION_STATEMENT =
  /^[A-Za-z_][A-Za-z0-9_]*\s+(?:\*?(?:\[\])?[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*|map\[[^\]]+\][A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)(?:\s+`[^`]+`)?$/;
const CSHARP_AUTO_PROPERTY_STATEMENT =
  /^(?:(?:public|private|protected|internal)\s+)+(?:static\s+|virtual\s+|override\s+|sealed\s+|required\s+|readonly\s+|new\s+)*[A-Za-z_][A-Za-z0-9_<>,.?[\]]*\s+[A-Za-z_][A-Za-z0-9_]*\s*\{\s*get;\s*(?:set|init);\s*}(?:\s*=\s*.+)?;$/;
const MEMBER_OR_ASSIGNMENT_STATEMENT =
  /^(?:[A-Za-z_$][A-Za-z0-9_$]*)(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*(?:\s*(?:\.|=|:=|\+=|-=|\*=|\/=|%=|<<=|>>=|&=|\|=|\^=|=>|::|\+\+|--)|\s+.+)$/;

const BLANK_LINE_FRAGMENT_SIGNAL = /[)"'`\]}]/;
const COMMENT_ONLY_LINE = /^\s*(?:#|\/\/|\/\*+|\*+\/?|\*)/;
const MINIMAL_MEMBER_SUFFIX_FRAGMENT =
  /^[A-Za-z_$][A-Za-z0-9_$]*(?:\((?:[A-Za-z_$][A-Za-z0-9_$]*)?\))?(?:;)?$/;
const BLANK_LINE_ARGUMENT_FRAGMENT =
  /^(?:(?:[A-Za-z_$][A-Za-z0-9_$]*\s*=\s*)?(?:"(?:[^"\\]|\\.)*"?(?:\s*)|'(?:[^'\\]|\\.)*'?(?:\s*)|`(?:[^`\\]|\\.)*`?(?:\s*)|(?:true|false|null|none|undefined)\b|[A-Za-z_$][A-Za-z0-9_$]*|\d+(?:\.\d+)?))(?:\s*,\s*(?:(?:[A-Za-z_$][A-Za-z0-9_$]*\s*=\s*)?(?:"(?:[^"\\]|\\.)*"?(?:\s*)|'(?:[^'\\]|\\.)*'?(?:\s*)|`(?:[^`\\]|\\.)*`?(?:\s*)|(?:true|false|null|none|undefined)\b|[A-Za-z_$][A-Za-z0-9_$]*|\d+(?:\.\d+)?)))*\s*[)\]}]*$/i;

export function isBlankLineAtCursor(
  linePrefix: string | undefined,
  lineSuffix: string | undefined,
): boolean {
  return !(linePrefix ?? '').trim() && !(lineSuffix ?? '').trim();
}

export type BlankLineHeuristicDecision = 'accept' | 'suspicious' | 'reject';

export function looksLikeStandaloneCodeStatement(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  if (LEADING_STATEMENT_KEYWORDS.test(trimmed)) {
    return true;
  }
  if (
    CALL_STATEMENT.test(trimmed)
    || INDEX_STATEMENT.test(trimmed)
    || JSON_PROPERTY_STATEMENT.test(trimmed)
    || TYPED_MEMBER_DECLARATION_STATEMENT.test(trimmed)
    || MEMBER_OR_ASSIGNMENT_STATEMENT.test(trimmed)
  ) {
    return true;
  }
  return /^(?:[#@]|\/\/|\/\*|\{|\[)/.test(trimmed);
}

export function looksLikeBlankLineCarryoverFragment(value: string, prefix: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes('\n')) {
    return false;
  }
  if (looksLikeStandaloneCodeStatement(trimmed)) {
    return false;
  }
  if (!BLANK_LINE_FRAGMENT_SIGNAL.test(trimmed)) {
    return false;
  }

  const recentLines = prefix.split(/\r?\n/);
  const startIndex = Math.max(0, recentLines.length - 24);
  const variants = buildCarryoverVariants(trimmed);
  for (let index = startIndex; index < recentLines.length; index += 1) {
    const line = recentLines[index] ?? '';
    if (variants.some((variant) => line.includes(variant))) {
      return true;
    }
  }
  return false;
}

export function looksLikeBlankLineArgumentCarryover(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes('\n')) {
    return false;
  }
  if (COMMENT_ONLY_LINE.test(trimmed) || LEADING_STATEMENT_KEYWORDS.test(trimmed)) {
    return false;
  }
  if (/^(?:[A-Za-z_$][A-Za-z0-9_$]*)(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*\s*\(/.test(trimmed)) {
    return false;
  }
  if (/^(?:[A-Za-z_$][A-Za-z0-9_$]*)(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(trimmed)) {
    return false;
  }

  const hasArgumentFragmentSignal =
    trimmed.includes(',')
    || /^[0-9"'`]/.test(trimmed)
    || /[)\]}]$/.test(trimmed);
  if (!hasArgumentFragmentSignal) {
    return false;
  }

  return BLANK_LINE_ARGUMENT_FRAGMENT.test(trimmed);
}

export function getFirstMeaningfulSuffixLine(suffix: string): string | undefined {
  if (!suffix) {
    return undefined;
  }

  for (const line of suffix.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    if (COMMENT_ONLY_LINE.test(line)) {
      continue;
    }
    return line.trim();
  }

  return undefined;
}

export function isDuplicateOfMeaningfulSuffixLine(
  value: string,
  suffix: string,
  linePrefix: string | undefined,
  lineSuffix: string | undefined,
): boolean {
  const effectiveLinePrefix = resolveEffectiveLinePrefix('', linePrefix);
  const effectiveLineSuffix = resolveEffectiveLineSuffix(suffix, lineSuffix);
  const trimmedValue = value.trim();
  if (!trimmedValue || !isBlankLineAtCursor(effectiveLinePrefix, effectiveLineSuffix)) {
    return false;
  }

  return areDuplicateComparableLinesEqual(getFirstMeaningfulSuffixLine(suffix), trimmedValue);
}

export function looksLikeBlankLineMemberSuffixCarryover(value: string, suffix: string): boolean {
  const trimmedValue = value.trim();
  if (!trimmedValue || trimmedValue.includes('\n')) {
    return false;
  }
  if (!MINIMAL_MEMBER_SUFFIX_FRAGMENT.test(trimmedValue)) {
    return false;
  }

  const suffixLine = getFirstMeaningfulSuffixLine(suffix);
  if (!suffixLine) {
    return false;
  }

  return /(?:\.|::)[A-Za-z_$][A-Za-z0-9_$]*$/.test(suffixLine.trimEnd());
}

export function classifyGenericBlankLinePlaceholder(
  linePrefix: string | undefined,
  lineSuffix: string | undefined,
  prefix: string,
  suffix: string,
  suggestion: string,
): BlankLineHeuristicDecision {
  const effectiveLinePrefix = resolveEffectiveLinePrefix(prefix, linePrefix);
  const effectiveLineSuffix = resolveEffectiveLineSuffix(suffix, lineSuffix);
  if (!isBlankLineAtCursor(effectiveLinePrefix, effectiveLineSuffix)) {
    return 'accept';
  }
  if (isBlankLineStructuralContinuation(prefix, effectiveLinePrefix)) {
    return 'accept';
  }

  const trimmedSuggestion = suggestion.trim();
  if (!trimmedSuggestion) {
    return 'accept';
  }

  if (COMMENT_ONLY_LINE.test(trimmedSuggestion)) {
    return 'reject';
  }

  const indentLength = getIndentLength(effectiveLinePrefix);
  const firstMeaningfulSuffixLine = getFirstMeaningfulSuffixLine(suffix);
  const meaningfulSuffixLines = getMeaningfulSameIndentSuffixLines(suffix, indentLength, 24);
  if (trimmedSuggestion === 'pass') {
    if (firstMeaningfulSuffixLine && firstMeaningfulSuffixLine !== 'pass') {
      return 'reject';
    }

    const nearbySameIndentLines = getNearbySameIndentMeaningfulLines(prefix, suffix, indentLength);
    return nearbySameIndentLines.some((line) => (
      /^\s*return\s+\S/.test(line)
      || /^\s*[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*\s*=\s*\S/.test(line)
    ))
      ? 'reject'
      : 'accept';
  }

  if (looksLikePunctuationOnlyBlankLinePlaceholder(trimmedSuggestion)) {
    return 'suspicious';
  }

  if (looksLikeMisplacedControlFlowPlaceholder(trimmedSuggestion, firstMeaningfulSuffixLine)) {
    return 'suspicious';
  }

  if (!looksLikeStandaloneCodeStatement(trimmedSuggestion)) {
    return 'accept';
  }

  const nearbySameIndentLines = getNearbySameIndentMeaningfulLines(prefix, suffix, indentLength);
  const normalizedNearbyLines = nearbySameIndentLines.map((line) => line.trim());
  const duplicateComparableSuggestion = normalizeDuplicateComparableLine(trimmedSuggestion);

  if (
    normalizedNearbyLines.some((line) => (
      areDuplicateComparableLinesEqual(line, duplicateComparableSuggestion)
    ))
    && !CALL_STATEMENT.test(trimmedSuggestion)
  ) {
    return 'suspicious';
  }

  if (normalizedNearbyLines.some((line) => completesNearbyPartialLine(trimmedSuggestion, line))) {
    return 'suspicious';
  }

  if (looksLikeSelfAssignment(trimmedSuggestion)) {
    return 'suspicious';
  }

  if (
    looksLikeTypedMemberDeclaration(trimmedSuggestion)
    && isClosingDelimiterLine(firstMeaningfulSuffixLine)
    && normalizedNearbyLines.some((line) => looksLikeTypedMemberDeclaration(line))
  ) {
    return 'suspicious';
  }

  if (usesSuffixOnlyIdentifiers(trimmedSuggestion, prefix, suffix)) {
    return 'suspicious';
  }

  if (hasUnusedDeclaredTarget(trimmedSuggestion, meaningfulSuffixLines)) {
    return 'suspicious';
  }

  if (looksLikeUngroundedSpacerLineStatement(
    trimmedSuggestion,
    firstMeaningfulSuffixLine,
    normalizedNearbyLines,
  )) {
    return 'suspicious';
  }

  const returnedIdentifier = extractReturnedIdentifier(firstMeaningfulSuffixLine);
  if (!returnedIdentifier) {
    return 'accept';
  }

  return looksLikeSuspiciousReturnTargetAssignment(
    trimmedSuggestion,
    returnedIdentifier,
    normalizedNearbyLines,
  )
    ? 'suspicious'
    : 'accept';
}

export function looksLikeGenericBlankLinePlaceholder(
  linePrefix: string | undefined,
  lineSuffix: string | undefined,
  prefix: string,
  suffix: string,
  suggestion: string,
): boolean {
  return classifyGenericBlankLinePlaceholder(
    linePrefix,
    lineSuffix,
    prefix,
    suffix,
    suggestion,
  ) !== 'accept';
}

export function getExactNearbyBlankLineDuplicate(
  linePrefix: string | undefined,
  lineSuffix: string | undefined,
  prefix: string,
  suffix: string,
  suggestion: string,
): string | undefined {
  const effectiveLinePrefix = resolveEffectiveLinePrefix(prefix, linePrefix);
  const effectiveLineSuffix = resolveEffectiveLineSuffix(suffix, lineSuffix);
  if (!isBlankLineAtCursor(effectiveLinePrefix, effectiveLineSuffix)) {
    return undefined;
  }

  const trimmedSuggestion = suggestion.trim();
  if (!trimmedSuggestion || !looksLikeStandaloneCodeStatement(trimmedSuggestion)) {
    return undefined;
  }
  if (CALL_STATEMENT.test(trimmedSuggestion)) {
    return undefined;
  }

  const indentLength = getIndentLength(effectiveLinePrefix);
  const nearbySameIndentLines = getNearbySameIndentMeaningfulLines(prefix, suffix, indentLength);
  const duplicateLine = nearbySameIndentLines.find((line) => (
    areDuplicateComparableLinesEqual(line, trimmedSuggestion)
  ));
  return duplicateLine?.trim();
}

function normalizeDuplicateComparableLine(value: string | undefined): string {
  return (value ?? '').trim().replace(/[ \t]+/g, '');
}

function areDuplicateComparableLinesEqual(left: string | undefined, right: string | undefined): boolean {
  const normalizedLeft = normalizeDuplicateComparableLine(left);
  const normalizedRight = normalizeDuplicateComparableLine(right);
  return normalizedLeft.length > 0 && normalizedLeft === normalizedRight;
}

function buildCarryoverVariants(value: string): string[] {
  return Array.from(new Set([
    value,
    `"${value}`,
    `'${value}`,
    `\`${value}`,
    `(${value}`,
    `[${value}`,
    `{${value}`,
  ]));
}

function getIndentLength(line: string): number {
  return (line.match(/^\s*/) ?? [''])[0].length;
}

function getMeaningfulSameIndentSuffixLines(
  suffix: string,
  indentLength: number,
  maxCount: number,
): string[] {
  if (!suffix || maxCount <= 0) {
    return [];
  }

  const result: string[] = [];
  for (const line of suffix.split(/\r?\n/)) {
    if (!line.trim() || COMMENT_ONLY_LINE.test(line)) {
      continue;
    }

    const lineIndentLength = getIndentLength(line);
    if (lineIndentLength < indentLength) {
      break;
    }
    if (lineIndentLength !== indentLength) {
      continue;
    }

    result.push(line.trim());
    if (result.length >= maxCount) {
      break;
    }
  }

  return result;
}

function resolveEffectiveLinePrefix(prefix: string, linePrefix: string | undefined): string {
  return linePrefix ?? (prefix.split(/\r?\n/).pop() ?? '');
}

function resolveEffectiveLineSuffix(suffix: string, lineSuffix: string | undefined): string {
  return lineSuffix ?? (suffix.split(/\r?\n/)[0] ?? '');
}

function getNearbySameIndentMeaningfulLines(
  prefix: string,
  suffix: string,
  indentLength: number,
): string[] {
  return [
    ...prefix.split(/\r?\n/).slice(-24),
    ...suffix.split(/\r?\n/).slice(0, 12),
  ].filter((line) => {
    if (!line.trim() || COMMENT_ONLY_LINE.test(line)) {
      return false;
    }
    return getIndentLength(line) === indentLength;
  });
}

function completesNearbyPartialLine(suggestion: string, nearbyLine: string): boolean {
  if (!nearbyLine || nearbyLine === suggestion) {
    return false;
  }
  if (!looksLikePotentiallyIncompleteLine(nearbyLine)) {
    return false;
  }
  if (!suggestion.startsWith(nearbyLine)) {
    return false;
  }

  const remainder = suggestion.slice(nearbyLine.length);
  if (!remainder || remainder.length > 12 || remainder.includes('\n')) {
    return false;
  }
  if (/^\s+[A-Za-z_$]/.test(remainder)) {
    return false;
  }

  return /^[\sA-Za-z0-9_$()[\]{};:.,'"`+\-/*%<>=!?&|]*$/.test(remainder);
}

function looksLikePotentiallyIncompleteLine(value: string): boolean {
  return /(?:[A-Za-z_$][A-Za-z0-9_$]*|[)\]}'"`])$/.test(value)
    || /[([{:,+\-/*%&|=]\s*$/.test(value)
    || /(?:\.|::)[A-Za-z_$][A-Za-z0-9_$]*$/.test(value);
}

function looksLikeSelfAssignment(value: string): boolean {
  const assignmentMatch =
    /^(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*\1(?:\s*;)?$/.exec(value)
    ?? /^([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*\1(?:\s*;)?$/.exec(value);
  return assignmentMatch !== null;
}

function looksLikePunctuationOnlyBlankLinePlaceholder(value: string): boolean {
  return /^[)\]};,:]+$/.test(value);
}

function looksLikeMisplacedControlFlowPlaceholder(
  value: string,
  firstMeaningfulSuffixLine: string | undefined,
): boolean {
  const controlFlowMatch = /^(return|break|continue)(?:\b[\s\S]*?)?;?$/.exec(value);
  if (!controlFlowMatch) {
    return false;
  }

  const keyword = controlFlowMatch[1];
  if (!firstMeaningfulSuffixLine) {
    return false;
  }

  const remainder = value
    .slice(controlFlowMatch[1].length)
    .replace(/;$/, '')
    .trim();
  if (remainder) {
    return false;
  }

  return !new RegExp(`^${keyword}\\b`).test(firstMeaningfulSuffixLine);
}

function looksLikeTypedMemberDeclaration(value: string): boolean {
  return TYPED_MEMBER_DECLARATION_STATEMENT.test(value)
    || GO_STRUCT_FIELD_DECLARATION_STATEMENT.test(value)
    || CSHARP_AUTO_PROPERTY_STATEMENT.test(value)
    || JSON_PROPERTY_STATEMENT.test(value);
}

function isClosingDelimiterLine(line: string | undefined): boolean {
  if (!line) {
    return false;
  }

  return /^[\]})]+[,;]?$/.test(line);
}

function extractReturnedIdentifier(line: string | undefined): string | undefined {
  if (!line) {
    return undefined;
  }

  return /^\s*return\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/.exec(line)?.[1];
}

function looksLikeSuspiciousReturnTargetAssignment(
  suggestion: string,
  target: string,
  nearbyLines: string[],
): boolean {
  const escapedTarget = escapeRegExp(target);
  const assignmentPattern = new RegExp(
    `^(?:(?:const|let|var|final)\\s+)?(?:[A-Za-z_$][A-Za-z0-9_$<>\\[\\],?]*\\s+)?${escapedTarget}\\s*(?:=|\\+=|-=|\\*=|\\/=|%=|<<=|>>=|&=|\\|=|\\^=)\\s*\\S`,
  );
  if (!assignmentPattern.test(suggestion)) {
    return false;
  }

  const longerNearbyIdentifier = nearbyLines.some((line) => {
    const tokens = line.match(/\b[A-Za-z_$][A-Za-z0-9_$]*\b/g) ?? [];
    return tokens.some((token) => token.startsWith(target) && token.length > target.length);
  });
  if (longerNearbyIdentifier) {
    return true;
  }

  const nearbyBindingPattern = new RegExp(
    `\\b(?:const|let|var|final)?\\s*${escapedTarget}\\b\\s*(?:=|\\+=|-=|\\*=|\\/=|%=|<<=|>>=|&=|\\|=|\\^=)`,
  );
  return nearbyLines.some((line) => nearbyBindingPattern.test(line));
}

function hasUnusedDeclaredTarget(suggestion: string, suffixLines: string[]): boolean {
  const declaredTargets = extractAssignedOrDeclaredTargets(suggestion);
  if (declaredTargets.length === 0) {
    return false;
  }

  return !suffixLines.some((line) => referencesAnyTarget(line, declaredTargets));
}

function looksLikeUngroundedSpacerLineStatement(
  suggestion: string,
  firstMeaningfulSuffixLine: string | undefined,
  nearbyLines: string[],
): boolean {
  if (!firstMeaningfulSuffixLine) {
    return false;
  }

  const callLikeStatement = CALL_STATEMENT.test(suggestion)
    || INDEX_STATEMENT.test(suggestion)
    || looksLikeMemberChainStatement(suggestion);
  if (!callLikeStatement) {
    return false;
  }

  const suggestionIdentifiers = extractIdentifiers(suggestion);
  const nearbyIdentifiers = new Set(
    nearbyLines.flatMap((line) => extractIdentifiers(line).map((token) => token.toLowerCase())),
  );
  const hasNearbyOverlap = suggestionIdentifiers.some((token) => nearbyIdentifiers.has(token.toLowerCase()));
  if (!hasConcreteLiteralContent(suggestion) && !hasNearbyOverlap) {
    return true;
  }

  const returnedIdentifier = extractReturnedIdentifier(firstMeaningfulSuffixLine);
  if (
    !hasConcreteLiteralContent(suggestion)
    && returnedIdentifier
    && new RegExp(`^${escapeRegExp(returnedIdentifier)}(?:\\.|\\[)`).test(suggestion)
  ) {
    return true;
  }

  return false;
}

function hasConcreteLiteralContent(value: string): boolean {
  return /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\b(?:true|false|null|none|undefined|-?\d+(?:\.\d+)?)\b/i.test(value);
}

function looksLikeMemberChainStatement(value: string): boolean {
  return /^(?:[A-Za-z_$][A-Za-z0-9_$]*)(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+(?:\([^()\n]*\)|\[[^\n]*\])?(?:;)?$/.test(value);
}

function referencesAnyTarget(line: string, targets: string[]): boolean {
  return targets.some((target) => new RegExp(`\\b${escapeRegExp(target)}\\b`).test(line));
}

const IDENTIFIER_STOPWORDS = new Set([
  'async',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'default',
  'def',
  'else',
  'false',
  'finally',
  'for',
  'from',
  'function',
  'if',
  'import',
  'let',
  'new',
  'null',
  'pass',
  'private',
  'protected',
  'pub',
  'public',
  'raise',
  'return',
  'static',
  'switch',
  'throw',
  'true',
  'try',
  'undefined',
  'var',
  'while',
  'with',
  'yield',
]);

function usesSuffixOnlyIdentifiers(
  suggestion: string,
  prefix: string,
  suffix: string,
): boolean {
  const targetIdentifiers = new Set(extractAssignedOrDeclaredTargets(suggestion));
  const suggestionIdentifiers = extractIdentifiers(suggestion)
    .filter((token) => !targetIdentifiers.has(token));
  if (suggestionIdentifiers.length === 0) {
    return false;
  }

  const prefixIdentifiers = new Set(extractIdentifiers(takeNearbyPrefix(prefix)));
  const suffixIdentifiers = new Set(extractIdentifiers(takeNearbySuffix(suffix)));
  return suggestionIdentifiers.some((token) => (
    !prefixIdentifiers.has(token) && suffixIdentifiers.has(token)
  ));
}

function extractAssignedOrDeclaredTargets(value: string): string[] {
  const targets = new Set<string>();

  const declarationPatterns = [
    /^(?:const|let|var|final)\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/,
    /^"([A-Za-z_$][A-Za-z0-9_$]*)"\s*:/,
    /^(?:(?:public|private|protected|internal)\s+)+(?:static\s+|virtual\s+|override\s+|sealed\s+|required\s+|readonly\s+|new\s+)*[A-Za-z_][A-Za-z0-9_<>,.?[\]]*\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/,
    /^([A-Za-z_][A-Za-z0-9_]*)\s+(?:\*?(?:\[\])?[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*|map\[[^\]]+\][A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)(?:\s+`[^`]+`)?$/,
    /^[A-Za-z_$][A-Za-z0-9_$<>\[\], ?]*\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=/,
    /^([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:=|:=|\+=|-=|\*=|\/=|%=|<<=|>>=|&=|\|=|\^=)\s*/,
    /^([A-Za-z_$][A-Za-z0-9_$]*)\s*:/,
  ];

  for (const pattern of declarationPatterns) {
    const match = pattern.exec(value.trim());
    if (match?.[1]) {
      targets.add(match[1]);
    }
  }

  return [...targets];
}

function extractIdentifiers(value: string): string[] {
  const tokens = value.match(/\b[A-Za-z_$][A-Za-z0-9_$]*\b/g) ?? [];
  return tokens.filter((token) => !IDENTIFIER_STOPWORDS.has(token));
}

function takeNearbyPrefix(prefix: string): string {
  return prefix.split(/\r?\n/).slice(-24).join('\n');
}

function takeNearbySuffix(suffix: string): string {
  return suffix.split(/\r?\n/).slice(0, 12).join('\n');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
