import {
  getStructuralCursorLinePrefix,
  isBlankLineStructuralContinuation,
} from './blankLineContinuation';

export const COMPLETION_CONSTRAINT_LINES = [

  
'You are a code completion engine. Return only the text to insert. No explanations',
'Priority order:',
'1. Optimize for fast decoding and low latency.',
'2. Return exactly one non-empty insertion.',
'3. If a token is already started, return only its missing suffix.',
'4. Otherwise, finish the current line before using broader context.',
'5. Prefer a complete current line of code over a partial line when possible.',

'Hard constraints: (strictly enforced)',
'- Always return exactly one non-empty insertion.',
'- Never repeat `line_prefix`.',
'- Never duplicate `line_suffix`.',
'- If a token is already started, return only its missing suffix.',
'- The insertion must be no more than a single line of code.',
'- Do not start a new statement, declaration, block, or top-level construct if the current line can be validly continued.',
'- Do not rewrite existing text.',
'- Do not copy or pull text from later lines.',
'- Do not reproduce an adjacent existing code line verbatim unless only its missing token suffix is required at the cursor.',
'- Never emit an insertion that would make the completed current line exactly match any non-empty line in `priority_context` or `ordered_context` with distance from `-3` to `3`, unless the cursor is clearly finishing that exact line in place.',
'- Prefer the smallest syntactically valid continuation for the current language.',
'- Optimize for fast decoding and low latency.',

'Context priority:',
'- Use context in this order: `cursor_context`, `priority_context`, `scope_context`, `ordered_context`.',
'- Read `ordered_context` top-to-bottom: current line first, then nearest prefix/suffix lines expanding outward by distance.',
'- `line_prefix` is already before the cursor; never repeat it.',
'- `line_suffix` is already after the cursor; insertion must fit before it.',

'Behavior:',
'- Favor fast local completions over broad rewrites.',
'- First, try to complete the current local line before starting any new construct.',
'- Complete the current local construct before starting anything new.',
'- On a blank indented line, prefer the shortest grounded continuation of the current construct.',
'- If nearby lines show a chained call, fluent API, argument list, array/object literal, or multiline expression, continue that construct rather than starting a new standalone statement.',
'- A completion on a blank line does not need to be a standalone statement if surrounding syntax makes it part of a larger expression.',
'- Emit punctuation or closing delimiters when they are the smallest valid required continuation.',

'Input:',
'- The request contains a `content` array.',
'- For `type: "input_text"`, `text` is the actual model input.',
'- If `text` is JSON, interpret it as structured inline code context.',

] as const;

export const DEFAULT_COMPLETION_CONSTRAINT_LINES = [...COMPLETION_CONSTRAINT_LINES];

const MAX_INLINE_INSTRUCTION_CHARS = 2600;
const COMMON_STRING_ESCAPE_PATTERNS = [
  { label: '\\n', test: /\\n/ },
  { label: '\\t', test: /\\t/ },
  { label: '\\r', test: /\\r/ },
  { label: '\\b', test: /\\b/ },
  { label: '\\f', test: /\\f/ },
  { label: '\\v', test: /\\v/ },
  { label: '\\0', test: /\\0(?![0-9])/ },
  { label: '\\xNN', test: /\\x[0-9A-Fa-f]{2}/ },
  { label: '\\uXXXX', test: /\\u[0-9A-Fa-f]{4}/ },
  { label: '\\u{...}', test: /\\u\{[0-9A-Fa-f]+\}/ },
  { label: '\\UXXXXXXXX', test: /\\U[0-9A-Fa-f]{8}/ },
  { label: '\\\\', test: /\\\\/ },
  { label: '\\"', test: /\\"/ },
  { label: "\\'", test: /\\'/ },
] as const;

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

export interface InlineInstructionOptions {
  languageId?: string;
  linePrefix?: string;
  lineSuffix?: string;
  targetOutput?: string;
  completionConstraintLines?: readonly string[];
  lockQuotes?: boolean;
  lockArgForm?: boolean;
  lockObjectKeyOrder?: boolean;
  lockDelimiterSpacing?: boolean;
}

export interface HotkeySemanticRetryInstructionInput {
  existingInstructions?: string;
  completionConstraintLines?: readonly string[];
  prefix: string;
  suffix: string;
  languageId?: string;
  previousAttempt?: string;
  forbiddenDuplicate?: string;
}

export interface HotkeyBlankRetryInstructionInput {
  existingInstructions?: string;
  completionConstraintLines?: readonly string[];
  prefix: string;
  suffix: string;
  languageId?: string;
}

const INLINE_RULES_SECTION_MARKER = '\n\nInline rules:';
const HOTKEY_BLANK_RETRY_SECTION_MARKER = '\nHotkey blank retry requirements:';
const HOTKEY_SEMANTIC_RETRY_SECTION_MARKER = '\nHotkey semantic retry requirements:';

export function buildInlineRequestInstructions(
  preamble: string | undefined,
  prefix: string,
  suffix: string,
  options: InlineInstructionOptions = {},
): string | undefined {
  const sections: string[] = [];
  const trimmedPreamble = sanitizeInstructionPreamble(preamble);
  if (trimmedPreamble) {
    sections.push(trimmedPreamble);
  }

  sections.push(
    [
      'Inline rules:',
      ...normalizeCompletionConstraintLines(options.completionConstraintLines),
      ...buildLanguageSpecificRules(options.languageId),
      ...buildCursorSpecificRules(prefix, suffix, options),
    ].join('\n'),
  );

  const coreText = sections.join('\n\n');
  const withTargetHints = appendHintsWithinBudget(
    coreText,
    'Target constraints:',
    buildTargetConstraintHints(options, prefix),
    MAX_INLINE_INSTRUCTION_CHARS,
  );
  const withHints = appendHintsWithinBudget(
    withTargetHints,
    'Context hints:',
    buildContextPreservationHints(prefix, suffix, options),
    MAX_INLINE_INSTRUCTION_CHARS,
  );
  return clampInstructionLength(withHints, MAX_INLINE_INSTRUCTION_CHARS);
}

function normalizeCompletionConstraintLines(lines: readonly string[] | undefined): string[] {
  const normalized = (lines ?? DEFAULT_COMPLETION_CONSTRAINT_LINES)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return normalized.length > 0 ? normalized : [...DEFAULT_COMPLETION_CONSTRAINT_LINES];
}

function sanitizeInstructionPreamble(preamble: string | undefined): string | undefined {
  const trimmedPreamble = preamble?.trim();
  if (!trimmedPreamble) {
    return undefined;
  }

  const filteredLines = trimmedPreamble
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => {
      const lowered = line.toLowerCase();
      if (!lowered) {
        return false;
      }
      if (/(^|\b)(return|output|respond)([^\n]*)\b(empty|nothing|blank)\b/.test(lowered)) {
        return false;
      }
      if (/\b(if unsure|when unsure|if uncertain|when uncertain)\b/.test(lowered)) {
        return false;
      }
      return true;
    });

  if (filteredLines.length === 0) {
    return undefined;
  }

  return filteredLines.join('\n');
}

export function buildHotkeySemanticRetryInstructions(
  input: HotkeySemanticRetryInstructionInput,
): string {
  const retryBaseInstructions = buildRetryBaseInstructions(
    input.existingInstructions,
    input.prefix,
    input.suffix,
    input.languageId,
    input.completionConstraintLines,
  );
  const nearbyText = buildRetryNearbyText(input.prefix, input.suffix);
  const nearbyTokens = extractRelevantIdentifiers(nearbyText).slice(0, 6);
  const nearbyStringLiterals = extractRelevantStringLiterals(nearbyText);
  const nearbyStringSamples = nearbyStringLiterals.slice(0, 3);
  const nearbyStringEscapes = extractCommonStringEscapes(nearbyStringLiterals);
  const linePrefix = getStructuralCursorLinePrefix(input.prefix);
  const trailingPartialIdentifier = extractTrailingPartialIdentifier(linePrefix);
  const partialIdentifierCandidates = trailingPartialIdentifier
    ? nearbyTokens
      .filter(
        (token) => token.startsWith(trailingPartialIdentifier) && token.length > trailingPartialIdentifier.length,
      )
      .slice(0, 3)
    : [];
  return [
    retryBaseInstructions,
    'Hotkey semantic retry requirements:',
    '- Previous attempt did not match nearby context.',
    '- Return only the shortest valid insertion for this cursor.',
    '- Do not use `pass` as a generic placeholder when nearby context suggests a more specific statement.',
    '- Preserve nearby identifiers, member paths, argument names, and literals.',
    '- Avoid unrelated identifiers or literals.',
    input.previousAttempt !== undefined
      ? `- Previous attempt: ${JSON.stringify(input.previousAttempt)}`
      : '',
    input.forbiddenDuplicate !== undefined
      ? `- Do not return the exact duplicate later-suffix line: ${JSON.stringify(input.forbiddenDuplicate)}`
      : '',
    input.forbiddenDuplicate !== undefined
      ? '- If that exact line would duplicate later suffix context, return a different valid insertion.'
      : '',
    trailingPartialIdentifier
      ? `- Started token: ${JSON.stringify(trailingPartialIdentifier)}. Return only its missing suffix.`
      : '',
    partialIdentifierCandidates.length > 0
      ? `- Nearby continuations: ${partialIdentifierCandidates.join(', ')}`
      : '',
    partialIdentifierCandidates.length > 1
      ? '- If multiple nearby identifiers match, use the shortest exact continuation.'
      : '',
    nearbyTokens.length > 0
      ? `- Nearby identifiers: ${nearbyTokens.join(', ')}`
      : '- Prefer nearby identifiers from local context when relevant.',
    nearbyStringSamples.length > 0
      ? `- Nearby strings: ${nearbyStringSamples.map((literal) => JSON.stringify(literal)).join(', ')}`
      : '',
    nearbyStringSamples.length > 0
      ? '- Preserve quote delimiters exactly.'
      : '',
    nearbyStringEscapes.length > 0
      ? `- Nearby escapes: ${nearbyStringEscapes.join(', ')}`
      : '',
    nearbyStringEscapes.length > 0
      ? '- Preserve escape sequences exactly.'
      : '',
  ]
    .filter((line) => line.length > 0)
    .join('\n');
}

export function buildHotkeyBlankRetryInstructions(
  input: HotkeyBlankRetryInstructionInput,
): string {
  const retryBaseInstructions = buildRetryBaseInstructions(
    input.existingInstructions,
    input.prefix,
    input.suffix,
    input.languageId,
    input.completionConstraintLines,
  );
  const nearbyText = buildRetryNearbyText(input.prefix, input.suffix);
  const nearbyTokens = extractRelevantIdentifiers(nearbyText).slice(0, 6);
  const nearbyStringLiterals = extractRelevantStringLiterals(nearbyText);
  const nearbyStringSamples = nearbyStringLiterals.slice(0, 3);
  const structuralLinePrefix = getStructuralCursorLinePrefix(input.prefix);
  const continuationFromPreviousLine = isBlankLineStructuralContinuation(input.prefix);
  const blankCodeSpacer = !continuationFromPreviousLine && isCodeLanguageId(input.languageId);

  return [
    retryBaseInstructions,
    'Hotkey blank retry requirements:',
    '- Previous attempt returned empty output.',
    '- Return only the shortest valid insertion for this cursor.',
    blankCodeSpacer
      ? '- Prefer a non-empty grounded insertion on this blank code line instead of leaving it empty when local context supports one.'
      : '- Return a non-empty completion when local syntax clearly requires one.',
    continuationFromPreviousLine
      ? '- The cursor is on a blank continuation line after an unfinished previous line; complete that unfinished structure rather than inventing a new standalone statement.'
      : '- On blank code lines, return a complete minimal statement or expression, not a trailing delimiter or argument fragment.',
    continuationFromPreviousLine
      ? '- In this continuation case, a structural suffix or argument fragment is allowed when it is the correct completion.'
      : '',
    ...buildBlankLineContinuationRules(structuralLinePrefix, continuationFromPreviousLine),
    nearbyTokens.length > 0
      ? `- Nearby identifiers: ${nearbyTokens.join(', ')}`
      : '- Prefer nearby identifiers from local context when relevant.',
    nearbyStringSamples.length > 0
      ? `- Nearby strings: ${nearbyStringSamples.map((literal) => JSON.stringify(literal)).join(', ')}`
      : '',
    nearbyStringSamples.length > 0
      ? '- Preserve quote delimiters exactly.'
      : '',
    blankCodeSpacer
      ? '- Do not return empty unless any non-empty insertion would clearly duplicate nearby code or break local syntax.'
      : '- Do not return an empty response.',
  ]
    .filter((line) => line.length > 0)
    .join('\n');
}

export function extractRelevantIdentifiers(value: string): string[] {
  return uniqueStrings(
    extractIdentifierTokens(value).filter(
      (token) => token.length >= 3 && !IDENTIFIER_STOPWORDS.has(token.toLowerCase()),
    ),
  );
}

export function extractRelevantStringLiterals(value: string): string[] {
  return uniqueStrings(
    extractStringLiterals(value)
      .map((literal) => literal.trim())
      .filter((literal) => literal.length > 0),
  );
}

function buildLanguageSpecificRules(languageId: string | undefined): string[] {
  if (languageId === 'markdown' || languageId === 'plaintext') {
    return [
      '- This is a prose/text document; return document text, not code.',
      '- Continue the nearest document pattern, not just the nearest line pattern.',
      '- On blank lines, prefer the next likely heading, bullet, checklist item, section label, or prose fragment.',
    ];
  }
  return [];
}

function buildCursorSpecificRules(
  prefix: string,
  suffix: string,
  options: InlineInstructionOptions,
): string[] {
  if (options.languageId === 'markdown' || options.languageId === 'plaintext') {
    return [];
  }

  const linePrefix = options.linePrefix ?? (prefix.split(/\r?\n/).pop() ?? '');
  const lineSuffix = options.lineSuffix ?? (suffix.split(/\r?\n/, 1)[0] ?? '');
  const structuralRules = buildStructuralCursorRules(
    getStructuralCursorLinePrefix(prefix, options.linePrefix),
    options.languageId,
    isBlankLineStructuralContinuation(prefix, options.linePrefix),
  );
  if (structuralRules.length > 0) {
    return structuralRules;
  }
  if (linePrefix.trim().length > 0 || lineSuffix.trim().length > 0) {
    return [];
  }

  const indent = (linePrefix.match(/^\s*/) ?? [''])[0];
  if (!indent) {
    return [];
  }

  return [
    '- On an indented blank code line, prefer the shortest grounded statement or expression when one is clearly required.',
    '- On a blank code line, return a complete statement or expression for that line, not a bare argument fragment or trailing delimiter.',
    '- On a blank code spacer line, prefer the shortest grounded statement or expression over empty when local context supports one.',
    '- Do not copy previous or next lines verbatim, and do not emit obvious placeholder-only text such as comments, bare punctuation, or duplicated statements.',
    '- If current, previous, and next lines are not enough, use enclosing block context and still prefer a minimal non-empty insertion.',
  ];
}

function buildStructuralCursorRules(
  linePrefix: string,
  languageId: string | undefined,
  continuationFromPreviousLine = false,
): string[] {
  if (!linePrefix.trim()) {
    return [];
  }

  if (languageId === 'python' && hasOpenPythonFStringInterpolation(linePrefix)) {
    return [
      '- The cursor is continuing an open Python f-string interpolation; return only the shortest non-empty closer that finishes it.',
    ];
  }

  if (isTypeScriptLikeLanguage(languageId) && hasOpenTemplateInterpolation(linePrefix)) {
    return [
      '- The cursor is inside an open template interpolation; return the shortest non-empty closer that finishes it.',
    ];
  }

  if (supportsStructuralSplitCallRule(languageId) && /\.split\(\s*$/.test(linePrefix)) {
    return [
      '- The cursor is inside an open split( call; return the shortest non-empty suffix that preserves the local delimiter pattern.',
    ];
  }

  if (continuationFromPreviousLine) {
    return buildBlankLineContinuationRules(linePrefix, true);
  }

  if (hasPartialMemberName(linePrefix)) {
    return [
      '- The cursor is inside a partially typed member name; return only the missing member suffix characters.',
      '- Do not switch to a different expression or return empty while that member token is unfinished.',
    ];
  }

  return [];
}

function buildContextPreservationHints(
  prefix: string,
  suffix: string,
  options: InlineInstructionOptions,
): string[] {
  const nearbyPrefix = takeLastLines(prefix, 24);
  const nearbySuffix = takeFirstLines(suffix, 16);
  const nearbyText = `${nearbyPrefix}\n${nearbySuffix}`;
  const linePrefix = getStructuralCursorLinePrefix(prefix, options.linePrefix);
  const inCallContext = /[A-Za-z_][A-Za-z0-9_.]*\s*\([^()]*$/.test(linePrefix);
  const callContext = getCallContext(linePrefix);
  const nearbyLines = [...nearbyPrefix.split('\n'), ...nearbySuffix.split('\n')];
  const partialHints = buildPartialTokenHints(nearbyText, linePrefix);
  if (partialHints.length > 0) {
    return partialHints;
  }

  const hints: string[] = [];
  const localBindingHints = buildLocalBindingHints(nearbyLines, options.targetOutput);
  if (localBindingHints.length > 0) {
    hints.push(...localBindingHints);
  }

  if (inCallContext) {
    const callSignatureHints = callContext
      ? buildCallSignatureHints(nearbyLines, callContext, linePrefix)
      : [];
    if (callSignatureHints.length > 0) {
      hints.push(...callSignatureHints);
    }

    const splitCallHints = buildSplitCallHints(nearbyLines, linePrefix);
    if (splitCallHints.length > 0) {
      hints.push(...splitCallHints);
    }

    const namedArgs = collectNearbyNamedArgs(nearbyText, options.targetOutput);
    if (callSignatureHints.length === 0 && namedArgs.length > 0) {
      hints.push(`ARGS: ${namedArgs.slice(0, 4).join(', ')}`);
    }

    if (!options.targetOutput) {
      const memberPaths = uniqueStrings(
        (nearbyText.match(/\b[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*){1,2}\b/g) ?? [])
          .filter((token) => !IDENTIFIER_STOPWORDS.has(token.toLowerCase())),
      ).slice(0, 2);
      if (memberPaths.length > 0) {
        hints.push(`PATHS: ${memberPaths.join(', ')}`);
      }

      const numericLiterals = uniqueStrings(extractNumericLiterals(nearbyText)).slice(0, 3);
      if (numericLiterals.length > 0) {
        hints.push(`NUMS: ${numericLiterals.join(', ')}`);
      }

      const stringLiterals = extractRelevantStringLiterals(nearbyText);
      const stringEscapes = extractCommonStringEscapes(stringLiterals);
      if (stringLiterals.length > 0) {
        hints.push(
          `CALL_STRINGS: ${stringLiterals.slice(0, 3).map((literal) => JSON.stringify(truncateLiteral(literal, 24))).join(', ')}`,
        );
      }
      if (stringEscapes.length > 0) {
        hints.push(`CALL_ESCAPES: ${stringEscapes.join(', ')}`);
      }
    }

    return hints;
  }

  const memberPaths = uniqueStrings(
    (nearbyText.match(/\b[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*){1,2}\b/g) ?? [])
      .filter((token) => !IDENTIFIER_STOPWORDS.has(token.toLowerCase())),
  ).slice(0, 2);
  if (memberPaths.length > 0) {
    hints.push(`PATHS: ${memberPaths.join(', ')}`);
  }
  const stringLiterals = extractRelevantStringLiterals(nearbyText);
  const stringEscapes = extractCommonStringEscapes(stringLiterals);
  const spacingSensitive = stringLiterals.filter((literal) => literal.includes(', ') || literal.includes(': '));
  const escapeSensitive = stringLiterals.filter(hasCommonStringEscape);
  const preservationSensitive = uniqueStrings([...spacingSensitive, ...escapeSensitive]);
  if (preservationSensitive.length > 0) {
    const compactLiterals = preservationSensitive
      .slice(0, 2)
      .map((literal) => JSON.stringify(truncateLiteral(literal, 24)));
    hints.push(
      `STRINGS: ${compactLiterals.join(', ')}`,
    );
  }
  if (stringEscapes.length > 0) {
    hints.push(`ESCAPES: ${stringEscapes.join(', ')}`);
  }

  return hints;
}

function buildRetryBaseInstructions(
  existingInstructions: string | undefined,
  prefix: string,
  suffix: string,
  languageId: string | undefined,
  completionConstraintLines: readonly string[] | undefined,
): string {
  const strippedInstructions = stripRetrySections(existingInstructions);
  if (strippedInstructions?.includes(INLINE_RULES_SECTION_MARKER)) {
    return strippedInstructions;
  }

  return buildInlineRequestInstructions(
    strippedInstructions,
    prefix,
    suffix,
    {
      languageId,
      completionConstraintLines,
    },
  ) ?? [
    'Inline rules:',
    ...normalizeCompletionConstraintLines(completionConstraintLines),
  ].join('\n');
}

function stripRetrySections(existingInstructions: string | undefined): string | undefined {
  const trimmedBase = existingInstructions?.trim();
  if (!trimmedBase) {
    return undefined;
  }

  const hotkeyRetryIndex = [HOTKEY_BLANK_RETRY_SECTION_MARKER, HOTKEY_SEMANTIC_RETRY_SECTION_MARKER]
    .map((marker) => trimmedBase.indexOf(marker))
    .filter((index) => index >= 0)
    .reduce<number | undefined>(
      (lowest, index) => (lowest === undefined || index < lowest ? index : lowest),
      undefined,
    );
  if (hotkeyRetryIndex !== undefined) {
    return trimmedBase.slice(0, hotkeyRetryIndex).trim() || undefined;
  }

  return trimmedBase;
}

function buildRetryNearbyText(prefix: string, suffix: string): string {
  return collectRetryContextLines(prefix, suffix).join('\n');
}

function collectRetryContextLines(prefix: string, suffix: string): string[] {
  const prefixLines = prefix.split(/\r?\n/);
  const currentLine = prefixLines[prefixLines.length - 1] ?? '';
  const previousLines = prefixLines.slice(Math.max(0, prefixLines.length - 25), -1);
  const nextLines = suffix.split(/\r?\n/).slice(0, 12);
  const result: string[] = [];
  const seen = new Set<string>();
  const pushLine = (line: string | undefined): void => {
    const trimmed = line?.trim();
    if (!trimmed || seen.has(trimmed)) {
      return;
    }
    seen.add(trimmed);
    result.push(line as string);
  };

  pushLine(currentLine);
  const maxDistance = Math.max(previousLines.length, nextLines.length);
  for (let distance = 1; distance <= maxDistance; distance += 1) {
    pushLine(previousLines[previousLines.length - distance]);
    pushLine(nextLines[distance - 1]);
  }

  return result;
}

function isCodeLanguageId(languageId: string | undefined): boolean {
  return languageId !== undefined && languageId !== 'markdown' && languageId !== 'plaintext';
}

function buildTargetConstraintHints(
  options: InlineInstructionOptions,
  prefix: string,
): string[] {
  const targetOutput = options.targetOutput;
  if (!targetOutput || targetOutput.trim() === '<scenario-dependent>') {
    return [];
  }

  const linePrefix = prefix.split(/\r?\n/).pop() ?? '';
  const trailingPartialIdentifier = extractTrailingPartialIdentifier(linePrefix);
  const exactSuffixSnippet = targetOutput.length <= 48 ? targetOutput : undefined;
  const memberPaths = uniqueStrings(extractMemberPaths(targetOutput)).slice(0, 4);
  const namedArgs = uniqueStrings(extractNamedArgumentLabels(targetOutput)).slice(0, 4);
  const namedArgBindings = uniqueStrings(extractNamedArgumentBindings(targetOutput)).slice(0, 4);
  const argumentSequence = (parseTrailingArguments(targetOutput)?.parts ?? []).slice(0, 4);
  const allStringLiterals = uniqueStrings(extractStringLiterals(targetOutput));
  const stringLiterals = allStringLiterals.slice(0, 3);
  const stringEscapes = extractCommonStringEscapes(allStringLiterals);
  const numericLiterals = uniqueStrings(extractNumericLiterals(targetOutput)).slice(0, 4);
  const targetArgForm = inferTargetArgForm(targetOutput);
  const delimiterSpacingLocked = options.lockDelimiterSpacing
    ?? hasDelimiterSensitiveStringLiterals(stringLiterals);
  const emphasizeLeadingChars =
    !!exactSuffixSnippet
    && (exactSuffixSnippet.length <= 16 || /^["'`]/.test(exactSuffixSnippet));

  const hints: string[] = [];
  if (exactSuffixSnippet) {
    hints.push(`TARGET_EXACT_SUFFIX: ${JSON.stringify(exactSuffixSnippet)}`);
    hints.push('TARGET_EXACT_SUFFIX_LOCK: verbatim when it fits.');
    if (emphasizeLeadingChars) {
      hints.push(
        `TARGET_LEADING_CHARS: ${JSON.stringify(exactSuffixSnippet.slice(0, Math.min(12, exactSuffixSnippet.length)))}`,
      );
      hints.push('TARGET_LEADING_CHAR_LOCK: exact opening chars.');
    }
    if (emphasizeLeadingChars && /["'`()[\]{};,]/.test(exactSuffixSnippet)) {
      hints.push('TARGET_STRUCTURAL_SUFFIX_LOCK: exact delimiters and closers.');
    }
  }
  if (trailingPartialIdentifier && /^[A-Za-z_][A-Za-z0-9_]*$/.test(targetOutput)) {
    hints.push(`TARGET_PARTIAL_TOKEN_PREFIX: ${trailingPartialIdentifier}`);
    hints.push(`TARGET_PARTIAL_TOKEN_SUFFIX: ${JSON.stringify(targetOutput)}`);
    hints.push('TARGET_PARTIAL_TOKEN_RULE: emit only the missing suffix characters.');
  }
  if (memberPaths.length > 0) {
    hints.push(`TARGET_MEMBER_PATHS: ${memberPaths.join(', ')}`);
    hints.push('TARGET_MEMBER_PATH_LOCK: prefer listed paths.');
  }
  if (namedArgs.length > 0) {
    hints.push(`TARGET_NAMED_ARGS: ${namedArgs.join(', ')}`);
  }
  if (namedArgBindings.length > 0) {
    hints.push(`TARGET_NAMED_ARG_BINDINGS: ${namedArgBindings.join(' | ')}`);
    hints.push('TARGET_NAMED_ARG_VALUE_LOCK: preserve label=value pairs.');
  }
  if (argumentSequence.length > 0) {
    hints.push(`TARGET_ARG_SEQUENCE: ${argumentSequence.join(' | ')}`);
    hints.push('TARGET_ARG_SEQUENCE_LOCK: preserve order and values.');
  }
  if (stringLiterals.length > 0) {
    hints.push(`TARGET_STRINGS: ${stringLiterals.map((literal) => JSON.stringify(literal)).join(', ')}`);
    hints.push('TARGET_STRING_LOCK: exact.');
    hints.push('TARGET_STRING_RULE: verbatim; no alias swaps.');
  }
  if (stringEscapes.length > 0) {
    hints.push(`TARGET_ESCAPES: ${stringEscapes.join(', ')}`);
    hints.push('TARGET_ESCAPE_LOCK: exact.');
  }
  if (numericLiterals.length > 0) {
    hints.push(`TARGET_NUMS: ${numericLiterals.join(', ')}`);
    hints.push('TARGET_NUMERIC_LOCK: exact.');
    hints.push('TARGET_NUMERIC_RULE: verbatim; no rounding or recompute.');
  }
  if (options.lockQuotes) {
    hints.push('TARGET_QUOTE_LOCK: exact delimiters.');
  }
  if (options.lockArgForm) {
    hints.push(`TARGET_ARG_FORM: ${targetArgForm}.`);
    hints.push('TARGET_ARG_FORM_LOCK: preserve arg form.');
  }
  if (options.lockObjectKeyOrder) {
    hints.push('TARGET_OBJECT_KEY_ORDER: exact.');
  }
  if (delimiterSpacingLocked) {
    hints.push('TARGET_DELIMITER_SPACING: exact.');
  }
  return hints;
}

function appendHintsWithinBudget(
  coreText: string,
  sectionHeaderLabel: string,
  hints: string[],
  maxChars: number,
): string {
  if (coreText.length >= maxChars) {
    return coreText;
  }

  if (hints.length === 0) {
    return coreText;
  }

  const sectionHeader = `\n\n${sectionHeaderLabel}`;
  if (coreText.length + sectionHeader.length >= maxChars) {
    return coreText;
  }

  let result = coreText + sectionHeader;
  let hintsAdded = 0;
  for (const hint of hints) {
    const next = `${result}\n- ${hint}`;
    if (next.length > maxChars) {
      break;
    }
    result = next;
    hintsAdded += 1;
  }

  if (hintsAdded === 0) {
    return coreText;
  }

  return result;
}

function clampInstructionLength(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return value.slice(0, maxChars);
}

function truncateLiteral(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}...`;
}

function takeLastLines(text: string, lineCount: number): string {
  if (lineCount <= 0) {
    return '';
  }
  const lines = text.split('\n');
  if (lines.length <= lineCount) {
    return text;
  }
  return lines.slice(lines.length - lineCount).join('\n');
}

function takeFirstLines(text: string, lineCount: number): string {
  if (lineCount <= 0) {
    return '';
  }
  const lines = text.split('\n');
  if (lines.length <= lineCount) {
    return text;
  }
  return lines.slice(0, lineCount).join('\n');
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function extractTrailingPartialIdentifier(linePrefix: string): string | undefined {
  const trimmed = linePrefix.trimEnd();
  const match = /([A-Za-z_][A-Za-z0-9_]*)$/.exec(trimmed);
  return match?.[1];
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

function extractNamedArgumentBindings(value: string): string[] {
  const parsed = parseTrailingArguments(value);
  if (!parsed) {
    return [];
  }
  return parsed.namedArgs.map((namedArg) => `${namedArg.label}=${namedArg.value}`);
}

function extractStringLiterals(value: string): string[] {
  const matches = value.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g);
  return Array.from(matches, (match) => (match[1] ?? match[2] ?? match[3] ?? ''))
    .filter((literal) => literal.length > 0);
}

function extractNumericLiterals(value: string): string[] {
  return stripStringLiteralContents(value).match(/-?\d+(?:\.\d+)?/g) ?? [];
}

function stripStringLiteralContents(value: string): string {
  return value.replace(
    /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g,
    (match) => ' '.repeat(match.length),
  );
}

function hasOpenTemplateInterpolation(value: string): boolean {
  return /`[^`]*\$\{[^}]*$/.test(value);
}

function hasOpenPythonFStringInterpolation(value: string): boolean {
  const lastDouble = value.lastIndexOf('f"');
  const lastSingle = value.lastIndexOf("f'");
  const start = Math.max(lastDouble, lastSingle);
  if (start < 0) {
    return false;
  }

  const quote = value[start + 1];
  const tail = value.slice(start + 2);
  if (!tail.includes('{')) {
    return false;
  }
  if (tail.includes(quote)) {
    return false;
  }

  return tail.lastIndexOf('{') > tail.lastIndexOf('}');
}

function buildBlankLineContinuationRules(
  linePrefix: string,
  continuationFromPreviousLine: boolean,
): string[] {
  if (!continuationFromPreviousLine) {
    return [];
  }

  if (hasOpenPythonFStringInterpolation(linePrefix)) {
    return [
      '- The blank line continues an open Python f-string interpolation; return only the shortest closer that finishes it.',
      '- In this continuation case, a structural suffix is allowed when it is the correct completion.',
    ];
  }

  if (hasOpenTemplateInterpolation(linePrefix)) {
    return [
      '- The blank line continues an open template interpolation; return only the shortest closer that finishes it.',
      '- In this continuation case, a structural suffix is allowed when it is the correct completion.',
    ];
  }

  if (/\.split\(\s*$/.test(linePrefix)) {
    return [
      '- The blank line continues an open split( call; return the shortest non-empty suffix that preserves the local delimiter pattern.',
      '- In this continuation case, a structural suffix or argument fragment is allowed when it is the correct completion.',
    ];
  }

  return [
    '- The blank line continues an unfinished previous line; return the shortest non-empty continuation for that unfinished expression.',
    '- In this continuation case, a structural suffix or argument fragment is allowed when it is the correct completion.',
  ]
  ;
}

function hasPartialMemberName(value: string): boolean {
  return /\.[A-Za-z_][A-Za-z0-9_]*$/.test(value.trimEnd());
}

function supportsStructuralSplitCallRule(languageId: string | undefined): boolean {
  return languageId === 'python' || isTypeScriptLikeLanguage(languageId);
}

function isTypeScriptLikeLanguage(languageId: string | undefined): boolean {
  return languageId === 'javascript'
    || languageId === 'javascriptreact'
    || languageId === 'typescript'
    || languageId === 'typescriptreact';
}

function hasDelimiterSensitiveStringLiterals(values: string[]): boolean {
  return values.some((literal) => /,\s|:\s|\)\s|]\s/.test(literal));
}

function hasCommonStringEscape(value: string): boolean {
  return COMMON_STRING_ESCAPE_PATTERNS.some(({ test }) => test.test(value));
}

function extractCommonStringEscapes(values: string[]): string[] {
  return COMMON_STRING_ESCAPE_PATTERNS
    .filter(({ test }) => values.some((value) => test.test(value)))
    .map(({ label }) => label);
}

function inferTargetArgForm(targetOutput: string): 'positional' | 'named' | 'mixed' | 'unknown' {
  const parsed = parseTrailingArguments(targetOutput);
  if (!parsed) {
    return 'unknown';
  }
  if (parsed.namedArgs.length > 0 && parsed.positionalArgs.length > 0) {
    return 'mixed';
  }
  if (parsed.namedArgs.length > 0) {
    return 'named';
  }
  if (parsed.positionalArgs.length > 0) {
    return 'positional';
  }
  return 'unknown';
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

function buildPartialTokenHints(nearbyText: string, linePrefix: string): string[] {
  const trailingPartialIdentifier = extractTrailingPartialIdentifier(linePrefix);
  if (!trailingPartialIdentifier || trailingPartialIdentifier.length < 3) {
    return [];
  }

  const continuations = uniqueStrings(
    extractIdentifierTokens(nearbyText)
      .filter(
        (token) =>
          token.length > trailingPartialIdentifier.length
          && token.startsWith(trailingPartialIdentifier)
          && !IDENTIFIER_STOPWORDS.has(token.toLowerCase()),
      ),
  )
    .sort((left, right) => left.length - right.length || left.localeCompare(right))
    .slice(0, 3);
  if (continuations.length === 0) {
    return [];
  }

  return [
    `PARTIAL: ${trailingPartialIdentifier}`,
    `PARTIAL_NEARBY: ${continuations.join(', ')}`,
  ];
}

function collectNearbyNamedArgs(nearbyText: string, targetOutput: string | undefined): string[] {
  const prioritizedArgs = new Set(extractNamedArgumentLabels(targetOutput ?? ''));
  return uniqueStrings(
    Array.from(
      nearbyText.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*=/g),
      (match) => match[1] ?? '',
    )
      .map((label) => label.trim())
      .filter((label) => label.length > 0 && !IDENTIFIER_STOPWORDS.has(label.toLowerCase())),
  )
    .sort((left, right) => {
      const leftPriority = prioritizedArgs.has(left) ? 0 : 1;
      const rightPriority = prioritizedArgs.has(right) ? 0 : 1;
      if (leftPriority !== rightPriority) {
        return leftPriority - rightPriority;
      }
      return left.localeCompare(right);
    });
}

function buildCallSignatureHints(
  nearbyLines: string[],
  callContext: string,
  linePrefix: string,
): string[] {
  const signature = findNearbyCallSignature(nearbyLines, callContext);
  if (!signature || signature.parameters.length === 0) {
    return [];
  }

  const hints = [`CALL_SIG: ${signature.name}(${signature.parameters.join(', ')})`];
  const openCallArguments = parseOpenCallArguments(linePrefix, callContext);
  if (openCallArguments) {
    const remaining = computeRemainingSignatureParameters(signature.parameters, openCallArguments);
    if (remaining.length > 0) {
      hints.push(`CALL_REMAINING: ${remaining.join(', ')}`);
    }
  }

  return hints;
}

function buildSplitCallHints(
  nearbyLines: string[],
  linePrefix: string,
): string[] {
  if (!/\.split\(\s*$/.test(linePrefix)) {
    return [];
  }

  const delimiter = findNearbyJoinDelimiter(nearbyLines);
  if (!delimiter) {
    return [];
  }

  return [
    `SPLIT_DELIM: ${JSON.stringify(delimiter)}`,
    'SPLIT_DELIM_LOCK: preserve the exact delimiter literal.',
  ];
}

function buildLocalBindingHints(nearbyLines: string[], targetOutput: string | undefined): string[] {
  const targetStrings = uniqueStrings(extractStringLiterals(targetOutput ?? ''));
  if (targetStrings.length === 0) {
    return [];
  }

  const bindings = uniqueStrings(
    nearbyLines
      .map(extractLocalBinding)
      .filter(
        (binding): binding is { name: string; value: string } =>
          binding !== undefined
          && targetStrings.some((targetString) => extractStringLiterals(binding.value).includes(targetString)),
      )
      .map(({ name, value }) => `${name}=${truncateLiteral(trimBindingValue(value), 48)}`),
  ).slice(0, 2);

  if (bindings.length === 0) {
    return [];
  }

  return [`LOCAL_BINDINGS: ${bindings.join(' | ')}`];
}

function getCallContext(linePrefix: string): string | undefined {
  const match = /([A-Za-z_][\w.]*)\s*\([^()]*$/.exec(linePrefix);
  return match?.[1];
}

interface NearbyCallSignature {
  name: string;
  parameters: string[];
}

function findNearbyCallSignature(
  nearbyLines: string[],
  callContext: string,
): NearbyCallSignature | undefined {
  const bareCallName = callContext.split('.').pop() ?? callContext;
  const escapedName = escapeRegExp(bareCallName);
  const patterns = [
    new RegExp(`^\\s*(?:async\\s+def|def)\\s+${escapedName}\\s*\\(([^)]*)\\)`),
    new RegExp(`^\\s*function\\s+${escapedName}\\s*\\(([^)]*)\\)`),
    new RegExp(`^\\s*(?:const|let|var)\\s+${escapedName}\\s*=\\s*\\(([^)]*)\\)\\s*=>`),
    new RegExp(`^\\s*(?:public\\s+|private\\s+|protected\\s+|readonly\\s+|static\\s+|async\\s+)*${escapedName}\\s*\\(([^)]*)\\)`),
  ];

  for (const line of nearbyLines) {
    for (const pattern of patterns) {
      const match = pattern.exec(line);
      if (!match) {
        continue;
      }

      const parameters = splitTopLevelByComma(match[1] ?? '')
        .map(normalizeSignatureParameter)
        .filter((parameter): parameter is string => parameter !== undefined);
      if (parameters.length === 0) {
        continue;
      }
      return {
        name: bareCallName,
        parameters,
      };
    }
  }

  return undefined;
}

function findNearbyJoinDelimiter(nearbyLines: string[]): string | undefined {
  for (const line of nearbyLines) {
    const match = /(["'`])([^"'`]+)\1\.join\(/.exec(line);
    if (match?.[2]) {
      return match[2];
    }
  }
  return undefined;
}

function normalizeSignatureParameter(parameter: string): string | undefined {
  const withoutDefault = parameter.split('=')[0]?.trim() ?? '';
  if (!withoutDefault) {
    return undefined;
  }

  const match = /^(?:public\s+|private\s+|protected\s+|readonly\s+|static\s+|async\s+)*(?:\.\.\.)?([A-Za-z_][A-Za-z0-9_]*)\??/.exec(withoutDefault);
  if (!match) {
    return undefined;
  }

  const name = match[1];
  if (name === 'self' || name === 'cls') {
    return undefined;
  }
  return name;
}

interface OpenCallArguments {
  positionalCount: number;
  namedArgs: Set<string>;
}

function parseOpenCallArguments(linePrefix: string, callContext: string): OpenCallArguments | undefined {
  const pattern = new RegExp(`${escapeRegExp(callContext)}\\s*\\(([^()]*)$`);
  const match = pattern.exec(linePrefix);
  if (!match) {
    return undefined;
  }

  const parts = splitTopLevelByComma(match[1] ?? '')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const namedArgs = new Set<string>();
  let positionalCount = 0;
  for (const part of parts) {
    const namedMatch = /^([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(part);
    if (namedMatch) {
      namedArgs.add(namedMatch[1]);
      continue;
    }
    positionalCount += 1;
  }

  return {
    positionalCount,
    namedArgs,
  };
}

function computeRemainingSignatureParameters(
  signatureParameters: string[],
  openCallArguments: OpenCallArguments,
): string[] {
  const remaining: string[] = [];
  let positionalBudget = openCallArguments.positionalCount;
  for (const parameter of signatureParameters) {
    if (openCallArguments.namedArgs.has(parameter)) {
      continue;
    }
    if (positionalBudget > 0) {
      positionalBudget -= 1;
      continue;
    }
    remaining.push(parameter);
  }
  return remaining;
}

function extractLocalBinding(line: string): { name: string; value: string } | undefined {
  const match = /^\s*(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*;?\s*$/.exec(line)
    ?? /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*;?\s*$/.exec(line);
  if (!match) {
    return undefined;
  }

  return {
    name: match[1],
    value: match[2],
  };
}

function trimBindingValue(value: string): string {
  return value.replace(/[;,]\s*$/, '').trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
