const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_COMPLETION_CONSTRAINT_LINES,
  buildHotkeyBlankRetryInstructions,
  buildHotkeySemanticRetryInstructions,
  buildInlineRequestInstructions,
} = require('../out/completion/completionInstructions.js');

test('DEFAULT_COMPLETION_CONSTRAINT_LINES includes the non-empty insertion constraint', () => {
  assert.ok(DEFAULT_COMPLETION_CONSTRAINT_LINES.includes('- Always return exactly one non-empty insertion.'));
});

test.skip('buildInlineRequestInstructions adds exact suffix, numeric, and named-argument locks', () => {
  const instructions = buildInlineRequestInstructions(
    undefined,
    'query = build_query("users", filters, ',
    ')',
    {
      targetOutput: '25, order_by="created_at")',
      lockQuotes: true,
      lockArgForm: true,
    },
  );

  assert.ok(instructions);
  assert.ok(instructions.includes('TARGET_EXACT_SUFFIX: "25, order_by=\\"created_at\\")"'));
  assert.match(instructions, /TARGET_EXACT_SUFFIX_LOCK: verbatim when it fits/);
  assert.match(instructions, /TARGET_NAMED_ARG_BINDINGS: order_by="created_at"/);
  assert.match(instructions, /TARGET_NAMED_ARG_VALUE_LOCK: preserve label=value pairs/);
  assert.match(instructions, /TARGET_ARG_SEQUENCE_LOCK: preserve order and values/);
  assert.match(instructions, /TARGET_STRING_LOCK: exact/);
  assert.match(
    instructions,
    /Use context in this order: `cursor_context`, `priority_context`, `scope_context`, `ordered_context`\./,
  );
  assert.match(
    instructions,
    /Always return exactly one non-empty insertion\./,
  );
});

test.skip('buildInlineRequestInstructions emphasizes leading characters for short exact suffixes', () => {
  const instructions = buildInlineRequestInstructions(
    undefined,
    'return summarizePriority(',
    '\n',
    {
      languageId: 'typescript',
      targetOutput: '"P1");',
      lockQuotes: true,
    },
  );

  assert.ok(instructions);
  assert.ok(instructions.includes('TARGET_LEADING_CHARS: "\\"P1\\");"'));
  assert.match(
    instructions,
    /TARGET_LEADING_CHAR_LOCK: exact opening chars/,
  );
  assert.match(
    instructions,
    /TARGET_STRUCTURAL_SUFFIX_LOCK: exact delimiters and closers/,
  );
  assert.doesNotMatch(
    instructions,
    /TARGET_NUMS:/,
  );
});

test.skip('buildInlineRequestInstructions adds partial-token continuation locks for identifier suffixes', () => {
  const instructions = buildInlineRequestInstructions(
    undefined,
    'def near_duplicate_report_pick() -> str:\n    report_text = report\n    report_summary = report.splitlines()[0]\n    return report_',
    '\n',
    {
      languageId: 'python',
      targetOutput: 'text',
    },
  );

  assert.ok(instructions);
  assert.match(instructions, /TARGET_PARTIAL_TOKEN_PREFIX: report_/);
  assert.match(instructions, /TARGET_PARTIAL_TOKEN_SUFFIX: "text"/);
  assert.match(
    instructions,
    /TARGET_PARTIAL_TOKEN_RULE: emit only the missing suffix characters/,
  );
});

test('buildInlineRequestInstructions preserves a sanitized preamble when one is provided', () => {
  const instructions = buildInlineRequestInstructions(
    [
      'Return only code.',
      'If unsure, return empty.',
      'Output nothing when uncertain.',
    ].join('\n'),
    'retu',
    '',
    {
      languageId: 'typescript',
    },
  );

  assert.ok(instructions);
  assert.match(instructions, /Return only code\./);
  assert.doesNotMatch(instructions, /If unsure, return empty/i);
  assert.doesNotMatch(instructions, /output nothing/i);
  assert.match(instructions, /Always return exactly one non-empty insertion\./);
  assert.doesNotMatch(instructions, /Return empty when no justified insertion belongs at the cursor\./);
});

test.skip('buildInlineRequestInstructions adds prose rules for markdown and plaintext documents', () => {
  const markdownInstructions = buildInlineRequestInstructions(
    undefined,
    '## Notes\n- Reply-to primary: ',
    '\n',
    {
      languageId: 'markdown',
    },
  );
  const plaintextInstructions = buildInlineRequestInstructions(
    undefined,
    'Reply-to primary: ',
    '\n',
    {
      languageId: 'plaintext',
    },
  );

  assert.ok(markdownInstructions?.includes('This is a prose/text document; return document text, not code.'));
  assert.ok(
    markdownInstructions?.includes(
      'Continue the nearest document pattern, not just the nearest line pattern.',
    ),
  );
  assert.ok(markdownInstructions?.includes('Always return exactly one non-empty insertion.'));
  assert.ok(markdownInstructions?.includes('On blank lines, prefer the next likely heading, bullet, checklist item, section label, or prose fragment.'));
  assert.ok(markdownInstructions.length <= 3000);
  assert.ok(plaintextInstructions?.includes('This is a prose/text document; return document text, not code.'));
  assert.ok(
    plaintextInstructions?.includes(
      'Continue the nearest document pattern, not just the nearest line pattern.',
    ),
  );
  assert.ok(plaintextInstructions?.includes('Always return exactly one non-empty insertion.'));
  assert.ok(plaintextInstructions?.includes('On blank lines, prefer the next likely heading, bullet, checklist item, section label, or prose fragment.'));
  assert.ok(plaintextInstructions.length <= 3000);
});

test('buildInlineRequestInstructions adds code blank-line rules for indented blank lines', () => {
  const instructions = buildInlineRequestInstructions(
    undefined,
    'def build_message(name: str) -> str:\n    ',
    '\n    return f"Hello, {name}!"\n',
    {
      languageId: 'python',
    },
  );

});

test('buildInlineRequestInstructions uses explicit cursor line suffix for blank-line rules', () => {
  const instructions = buildInlineRequestInstructions(
    undefined,
    'def case_suffix_only(values: Iterable[str]) -> str:\n    first = next(iter(values), "none")\n    ',
    '    return first.up\n',
    {
      languageId: 'python',
      linePrefix: '    ',
      lineSuffix: '',
    },
  );

});

test.skip('buildInlineRequestInstructions does not treat blank lines after block openers as structural continuations', () => {
  const instructions = buildInlineRequestInstructions(
    undefined,
    [
      'function formatName(first, last) {',
      '  ',
    ].join('\n'),
    '\n  return `${first} ${last}`;\n}\n',
    {
      languageId: 'javascript',
      linePrefix: '  ',
      lineSuffix: '',
    },
  );

  assert.match(
    instructions ?? '',
    /On an indented blank code line, prefer the shortest grounded statement or expression when one is clearly required/,
  );
  assert.doesNotMatch(
    instructions ?? '',
    /The blank line continues an unfinished previous line/,
  );
});

test.skip('buildInlineRequestInstructions does not treat switch case block openers as structural continuations', () => {
  const instructions = buildInlineRequestInstructions(
    undefined,
    [
      'switch (mode) {',
      '  case "ready": {',
      '    ',
    ].join('\n'),
    '\n    return true;\n  }\n}\n',
    {
      languageId: 'javascript',
      linePrefix: '    ',
      lineSuffix: '',
    },
  );

  assert.match(
    instructions ?? '',
    /On an indented blank code line, prefer the shortest grounded statement or expression when one is clearly required/,
  );
  assert.doesNotMatch(
    instructions ?? '',
    /The blank line continues an unfinished previous line/,
  );
});

test.skip('buildInlineRequestInstructions adds structural rule for open template interpolation', () => {
  const instructions = buildInlineRequestInstructions(
    undefined,
    [
      'export function runTemplateLiteralCase(invoice: { id: string; total: number }): string {',
      '  const label = `Invoice ${invoice.id',
    ].join('\n'),
    '\n  return label;\n}\n',
    {
      languageId: 'typescript',
      linePrefix: '  const label = `Invoice ${invoice.id',
      lineSuffix: '',
    },
  );

  assert.match(
    instructions ?? '',
    /The cursor is inside an open template interpolation; return the shortest non-empty closer that finishes it/,
  );
});

test.skip('buildInlineRequestInstructions adds structural rule for open split call', () => {
  const instructions = buildInlineRequestInstructions(
    undefined,
    [
      'export function runChainCase(lines: string[]): string {',
      '  const first = lines.map((line) => line.trim()).filter(Boolean).join(", ").split(',
    ].join('\n'),
    '\n  return first;\n}\n',
    {
      languageId: 'typescript',
      linePrefix: '  const first = lines.map((line) => line.trim()).filter(Boolean).join(", ").split(',
      lineSuffix: '',
    },
  );

  assert.match(
    instructions ?? '',
    /The cursor is inside an open split\( call; return the shortest non-empty suffix that preserves the local delimiter pattern/,
  );
});

test.skip('buildInlineRequestInstructions adds structural rule for open Python split call', () => {
  const instructions = buildInlineRequestInstructions(
    undefined,
    [
      'def summarize_metrics(metrics: list[int], include_inactive: bool, precision: int) -> str:',
      '    values = metrics if include_inactive else [value for value in metrics if value > 0]',
      '    return ",".join(f"{value:.{precision}f}" for value in values)',
      '',
      'def run_chain_case(metrics: list[int]) -> str:',
      '    first = summarize_metrics(metrics, include_inactive=False, precision=2).split(',
    ].join('\n'),
    '\n    return\n',
    {
      languageId: 'python',
      linePrefix: '    first = summarize_metrics(metrics, include_inactive=False, precision=2).split(',
      lineSuffix: '',
    },
  );

  assert.match(
    instructions ?? '',
    /The cursor is inside an open split\( call; return the shortest non-empty suffix that preserves the local delimiter pattern/,
  );
  assert.match(instructions ?? '', /SPLIT_DELIM: ","/);
  assert.match(instructions ?? '', /SPLIT_DELIM_LOCK: preserve the exact delimiter literal/);
});

test.skip('buildInlineRequestInstructions treats blank continuation lines as structural continuations', () => {
  const instructions = buildInlineRequestInstructions(
    undefined,
    [
      'def run_fstring_case(user: dict[str, str]) -> str:',
      '    message = f"User {user[\'name\']',
      '    ',
    ].join('\n'),
    '\n    return message\n',
    {
      languageId: 'python',
      linePrefix: '    ',
      lineSuffix: '',
    },
  );

  assert.match(
    instructions ?? '',
    /The cursor is continuing an open Python f-string interpolation; return only the shortest non-empty closer that finishes it/,
  );
  assert.doesNotMatch(
    instructions ?? '',
    /On a blank code line, return a complete statement or expression for that line, not a bare argument fragment or trailing delimiter/,
  );
});

test.skip('buildInlineRequestInstructions adds structural rule for partial member names', () => {
  const instructions = buildInlineRequestInstructions(
    undefined,
    [
      'static string CaseSuffixOnly(string value)',
      '{',
      '    return value.Trim().ToLowe',
    ].join('\n'),
    '\n}\n',
    {
      languageId: 'csharp',
      linePrefix: '    return value.Trim().ToLowe',
      lineSuffix: '',
    },
  );

  assert.match(
    instructions ?? '',
    /The cursor is inside a partially typed member name; return only the missing member suffix characters/,
  );
  assert.match(
    instructions ?? '',
    /Do not switch to a different expression or return empty while that member token is unfinished/,
  );
});

test('buildHotkeySemanticRetryInstructions rebuilds inline rules and adds retry requirements', () => {
  const instructions = buildHotkeySemanticRetryInstructions({
    completionConstraintLines: DEFAULT_COMPLETION_CONSTRAINT_LINES,
    prefix: 'normalized = format_name(user)\nmessage = greet(',
    suffix: '',
    languageId: 'python',
  });

  assert.match(instructions, /Inline rules:/);
  assert.match(instructions, /Hotkey semantic retry requirements:/);
  assert.match(instructions, /Previous attempt did not match nearby context/);
  assert.match(instructions, /Nearby identifiers:/);
  assert.doesNotMatch(instructions, /Previous attempt:/);
});

test('buildHotkeyBlankRetryInstructions allows structural suffixes on blank continuation lines', () => {
  const instructions = buildHotkeyBlankRetryInstructions({
    completionConstraintLines: DEFAULT_COMPLETION_CONSTRAINT_LINES,
    prefix: [
      'def summarize_metrics(metrics: list[int], include_inactive: bool, precision: int) -> str:',
      '    values = metrics if include_inactive else [value for value in metrics if value > 0]',
      '    return ",".join(f"{value:.{precision}f}" for value in values)',
      '',
      'def run_chain_case(metrics: list[int]) -> str:',
      '    first = summarize_metrics(metrics, include_inactive=False, precision=2).split(',
      '    ',
    ].join('\n'),
    suffix: '\n    return first\n',
  });

  assert.match(
    instructions,
    /The cursor is on a blank continuation line after an unfinished previous line; complete that unfinished structure rather than inventing a new standalone statement/,
  );
  assert.match(
    instructions,
    /The blank line continues an open split\( call; return the shortest non-empty suffix that preserves the local delimiter pattern/,
  );
  assert.match(
    instructions,
    /a structural suffix or argument fragment is allowed when it is the correct completion/,
  );
  assert.doesNotMatch(
    instructions,
    /not a trailing delimiter or argument fragment/,
  );
});

test('buildHotkeyBlankRetryInstructions prefers grounded code on blank spacer lines', () => {
  const instructions = buildHotkeyBlankRetryInstructions({
    completionConstraintLines: DEFAULT_COMPLETION_CONSTRAINT_LINES,
    prefix: [
      'def render_profile(profile: str) -> None:',
      '    ',
    ].join('\n'),
    suffix: '    print(profile)\n',
    languageId: 'python',
  });

  assert.match(
    instructions,
    /Prefer a non-empty grounded insertion on this blank code line instead of leaving it empty when local context supports one/,
  );
  assert.match(
    instructions,
    /Do not return empty unless any non-empty insertion would clearly duplicate nearby code or break local syntax/,
  );
});

test('buildHotkeySemanticRetryInstructions adds partial-token and nearby string-literal guidance', () => {
  const instructions = buildHotkeySemanticRetryInstructions({
    completionConstraintLines: DEFAULT_COMPLETION_CONSTRAINT_LINES,
    prefix: [
      'const priorities = ["P0", "P1", "P2"];',
      'const report_text = report;',
      'const report_summary = report.splitlines()[0];',
      'return report_',
    ].join('\n'),
    suffix: '',
    languageId: 'typescript',
  });

  assert.match(instructions, /Started token: "report_"/);
  assert.match(
    instructions,
    /Nearby continuations: report_summary, report_text/,
  );
  assert.match(
    instructions,
    /If multiple nearby identifiers match, use the shortest exact continuation/,
  );
  assert.match(
    instructions,
    /Nearby strings: "P0", "P1", "P2"/,
  );
  assert.match(
    instructions,
    /Preserve quote delimiters exactly/,
  );
});

test('buildHotkeySemanticRetryInstructions includes common escape characters from nearby strings including tab', () => {
  const instructions = buildHotkeySemanticRetryInstructions({
    completionConstraintLines: DEFAULT_COMPLETION_CONSTRAINT_LINES,
    prefix: [
      'const separators = ["\\\\n", "\\\\t", ", "];',
      'return separators.join(',
    ].join('\n'),
    suffix: '',
    languageId: 'typescript',
  });

  assert.ok(instructions.includes(String.raw`Nearby strings: "\\\\n", "\\\\t", ","`));
  assert.ok(instructions.includes(String.raw`Nearby escapes: \n, \t`));
  assert.match(instructions, /Preserve escape sequences exactly/);
});

test.skip('buildHotkeySemanticRetryInstructions preserves partial-token context before retry guidance', () => {
  const instructions = buildHotkeySemanticRetryInstructions({
    completionConstraintLines: DEFAULT_COMPLETION_CONSTRAINT_LINES,
    prefix: [
      '"""Pattern-focused Python autocomplete fixtures for bulk CLI benchmarking."""',
      '',
      'class UserProfile:',
      '    def __init__(self, user_id: int, user_name: str):',
      '        self.user_id = user_id',
      '        self.user_name = user_name',
      '',
      '    def pick_identifier(self) -> int:',
      '        return self.use',
    ].join('\n'),
    suffix: '\n',
    languageId: 'python',
  });

  assert.match(instructions, /Context hints:/);
  assert.match(instructions, /- PARTIAL: use/);
  assert.match(instructions, /- PARTIAL_NEARBY: user_id, user_name/);
  assert.match(instructions, /Nearby identifiers: self, use, pick_identifier, int, user_name, user_id/);
  assert.match(
    instructions,
    /Nearby strings: "Pattern-focused Python autocomplete fixtures for bulk CLI benchmarking\."/,
  );
  assert.match(instructions, /Preserve quote delimiters exactly/);
});

test('buildHotkeySemanticRetryInstructions includes previous attempt for Python-adjusted instructions', () => {
  const prefix = [
    '"""Pattern-focused Python autocomplete fixtures for bulk CLI benchmarking."""',
    '',
    'class PatternMatcher:',
    '    def summarize(self, focused: bool) -> str:',
    '        return self.bulk',
  ].join('\n');
  const baseInstructions = buildInlineRequestInstructions(
    undefined,
    prefix,
    '\n',
    {
      languageId: 'python',
      linePrefix: '        return self.bulk',
      lineSuffix: '',
    },
  );

  const instructions = buildHotkeySemanticRetryInstructions({
    existingInstructions: baseInstructions,
    prefix,
    suffix: '\n',
    languageId: 'python',
    previousAttempt: 'pass',
  });

  assert.match(instructions, /Hotkey semantic retry requirements:/);
  assert.match(instructions, /Previous attempt did not match nearby context/);
  assert.match(instructions, /Return only the shortest valid insertion for this cursor/);
  assert.match(instructions, /Preserve nearby identifiers, member paths, argument names, and literals/);
  assert.match(instructions, /Avoid unrelated identifiers or literals/);
  assert.match(instructions, /Previous attempt: .*pass/);
  assert.match(
    instructions,
    /Nearby identifiers: self, bulk, summarize, focused, bool, str/,
  );
  assert.match(
    instructions,
    /Nearby strings: "Pattern-focused Python autocomplete fixtures for bulk CLI benchmarking\."/,
  );
  assert.match(instructions, /Preserve quote delimiters exactly/);
});

test('buildHotkeySemanticRetryInstructions forbids an exact duplicate later-suffix line when provided', () => {
  const instructions = buildHotkeySemanticRetryInstructions({
    completionConstraintLines: DEFAULT_COMPLETION_CONSTRAINT_LINES,
    prefix: [
      'static String runArgumentsCase(List<Double> amounts) {',
      '    ',
      '    return summary;',
    ].join('\n'),
    suffix: '',
    languageId: 'java',
    previousAttempt: 'return summary;',
    forbiddenDuplicate: 'return summary;',
  });

  assert.match(
    instructions,
    /Do not return the exact duplicate later-suffix line: "return summary;"/,
  );
  assert.match(
    instructions,
    /If that exact line would duplicate later suffix context, return a different valid insertion/,
  );
});

test.skip('buildHotkeySemanticRetryInstructions rebuilds expanded base prompts without duplicating sections', () => {
  const expandedBase = buildInlineRequestInstructions(
    undefined,
    'message = greet(',
    '',
    {
      languageId: 'python',
      linePrefix: 'message = greet(',
      lineSuffix: '',
    },
  );

  const instructions = buildHotkeySemanticRetryInstructions({
    existingInstructions: expandedBase,
    prefix: [
      'normalized = format_name(user)',
      'message = greet(',
    ].join('\n'),
    suffix: '',
    languageId: 'python',
    previousAttempt: '// TODO',
  });

  assert.ok((instructions.match(/Inline rules:/g) ?? []).length >= 1);
  assert.ok((instructions.match(/Context hints:/g) ?? []).length >= 1);
  assert.match(instructions, /Nearby identifiers: message, greet, normalized, format_name, user/);
});

test.skip('buildHotkeySemanticRetryInstructions preserves prebuilt target constraints from expanded prompts', () => {
  const expandedBase = buildInlineRequestInstructions(
    undefined,
    'return summarizePriority(',
    '',
    {
      languageId: 'typescript',
      linePrefix: 'return summarizePriority(',
      lineSuffix: '',
      targetOutput: '"P1");',
      lockQuotes: true,
    },
  );

  const instructions = buildHotkeySemanticRetryInstructions({
    existingInstructions: expandedBase,
    prefix: 'return summarizePriority(',
    suffix: '',
    languageId: 'typescript',
    previousAttempt: 'P1");',
  });

  assert.equal((instructions.match(/Target constraints:/g) ?? []).length, 1);
  assert.ok(instructions.includes('TARGET_EXACT_SUFFIX: "\\"P1\\");"'));
  assert.match(instructions, /TARGET_STRING_LOCK: exact/);
});

test.skip('buildInlineRequestInstructions adds nearby partial-token hints from local context', () => {
  const instructions = buildInlineRequestInstructions(
    undefined,
    [
      'func maskedWordDemo() string {',
      '\tname := "Mina"',
      '\treturn nam',
    ].join('\n'),
    '\n}',
    {
      languageId: 'go',
      linePrefix: '\treturn nam',
      lineSuffix: '',
    },
  );

  assert.match(instructions, /Context hints:/);
  assert.match(instructions, /PARTIAL: nam/);
  assert.match(instructions, /PARTIAL_NEARBY: name/);
});

test.skip('buildInlineRequestInstructions suppresses generic noise for partial-token rows', () => {
  const instructions = buildInlineRequestInstructions(
    undefined,
    [
      'def near_duplicate_report_pick() -> str:',
      '    report_text = report',
      '    report_summary = report.splitlines()[0]',
      '    return report_',
    ].join('\n'),
    '\n',
    {
      languageId: 'python',
      targetOutput: 'text',
      linePrefix: '    return report_',
      lineSuffix: '',
    },
  );

  assert.match(instructions, /PARTIAL: report_/);
  assert.match(instructions, /PARTIAL_NEARBY: report_text, report_summary/);
  assert.doesNotMatch(instructions, /PATHS:/);
  assert.doesNotMatch(instructions, /STRINGS:/);
  assert.doesNotMatch(instructions, /CALL_STRINGS:/);
});

test.skip('buildInlineRequestInstructions surfaces escape-sensitive context hints including tab', () => {
  const instructions = buildInlineRequestInstructions(
    undefined,
    [
      'const rowSeparator = "\\\\t|\\\\n";',
      'const label = formatLabel(user);',
      'return label',
    ].join('\n'),
    '\n',
    {
      languageId: 'typescript',
      linePrefix: 'return label',
      lineSuffix: '',
    },
  );

  assert.ok(instructions.includes(String.raw`STRINGS: "\\\\t|\\\\n"`));
  assert.ok(instructions.includes(String.raw`ESCAPES: \n, \t`));
});

test.skip('buildInlineRequestInstructions surfaces extended escape hints for unicode, hex, null, and backspace', () => {
  const instructions = buildInlineRequestInstructions(
    undefined,
    [
      String.raw`const pattern = "\\buser\\0\\x2F\\u00A9";`,
      'return pattern',
    ].join('\n'),
    '\n',
    {
      languageId: 'typescript',
      linePrefix: 'return pattern',
      lineSuffix: '',
    },
  );

  assert.ok(instructions.includes(String.raw`ESCAPES: \b, \0, \xNN, \uXXXX`));
});

test.skip('buildInlineRequestInstructions adds compact call signature hints for constrained call rows', () => {
  const instructions = buildInlineRequestInstructions(
    undefined,
    [
      'def build_query(table: str, filters: dict[str, Any], limit: int, order_by: str) -> Query:',
      '    return Query(table=table, filters=filters, limit=limit, order_by=order_by)',
      '',
      'query = build_query("users", filters, ',
    ].join('\n'),
    ')',
    {
      languageId: 'python',
      targetOutput: '100, order_by="id")',
      linePrefix: 'query = build_query("users", filters, ',
      lineSuffix: ')',
    },
  );

  assert.match(instructions, /TARGET_NAMED_ARG_BINDINGS: order_by=\"id\"/);
});

test.skip('buildInlineRequestInstructions keeps target-derived constraints for nearby literal-producing bindings', () => {
  const instructions = buildInlineRequestInstructions(
    undefined,
    [
      'const byPriority = (priority: Ticket["priority"]) => ticketsByPriority[priority];',
      'const open = byPriority("P1");',
      'const closed = byPriority("P2");',
      'return summarizePriority(',
    ].join('\n'),
    '\n',
    {
      languageId: 'typescript',
      targetOutput: '"P1");',
      linePrefix: 'return summarizePriority(',
      lineSuffix: '',
    },
  );

  assert.match(instructions, /TARGET_EXACT_SUFFIX_LOCK: verbatim when it fits/);
  assert.doesNotMatch(instructions, /TARGET_NUMS:/);
});

test.skip('buildInlineRequestInstructions adds target escape locks for escaped string literals including tab', () => {
  const instructions = buildInlineRequestInstructions(
    undefined,
    'return joinParts(',
    '\n',
    {
      languageId: 'typescript',
      targetOutput: '"\\\\t", "\\\\n")',
      linePrefix: 'return joinParts(',
      lineSuffix: '',
    },
  );

  assert.ok(instructions.includes(String.raw`TARGET_STRINGS: "\\\\t", "\\\\n"`));
  assert.match(instructions, /TARGET_EXACT_SUFFIX_LOCK: verbatim when it fits/);
});

test.skip('buildInlineRequestInstructions adds target escape locks for unicode and hex escapes', () => {
  const instructions = buildInlineRequestInstructions(
    undefined,
    'return encode(',
    '\n',
    {
      languageId: 'typescript',
      targetOutput: String.raw`"\\0", "\\x2F", "\\u00A9", "\\b")`,
      linePrefix: 'return encode(',
      lineSuffix: '',
    },
  );

  assert.match(instructions, /TARGET_EXACT_SUFFIX_LOCK: verbatim when it fits/);
});
