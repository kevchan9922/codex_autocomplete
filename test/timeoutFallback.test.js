const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildTimeoutFallbackSuggestion,
} = require('../out/completion/timeoutFallback.js');

test('timeout fallback returns prior assignment identifier on blank python return', () => {
  const suggestion = buildTimeoutFallbackSuggestion({
    timedOutBeforeFirstChunk: true,
    languageId: 'python',
    prefix: [
      'def run_case(user):',
      '    message = f"User {user[\'name\']}"',
      '    return ',
    ].join('\n'),
  });

  assert.equal(suggestion, ' message');
});

test('timeout fallback returns unique near-duplicate suffix when local context is unambiguous', () => {
  const suggestion = buildTimeoutFallbackSuggestion({
    timedOutBeforeFirstChunk: true,
    languageId: 'python',
    prefix: [
      'def near_duplicate_report_pick() -> str:',
      '    report = build_report(METRICS)',
      '    report_text = report',
      '    report_summary = report.splitlines()[0]',
      '    return report_s',
    ].join('\n'),
  });

  assert.equal(suggestion, 'ummary');
});

test('timeout fallback returns unique identifier suffix for masked Go return variables', () => {
  const suggestion = buildTimeoutFallbackSuggestion({
    timedOutBeforeFirstChunk: true,
    languageId: 'go',
    prefix: [
      'func maskedWordDemo() string {',
      '\tname := "Mina"',
      '\treturn nam',
    ].join('\n'),
  });

  assert.equal(suggestion, 'e');
});

test('timeout fallback completes unique member suffix and semicolon for typed method chain', () => {
  const suggestion = buildTimeoutFallbackSuggestion({
    timedOutBeforeFirstChunk: true,
    languageId: 'typescript',
    prefix: [
      'function formatUserName(person: Person): string {',
      '  return person.name.toUpperCase();',
      '}',
      '',
      'export function methodChainCase(person: Person): string {',
      '  const upper = person.name.to',
    ].join('\n'),
    lineSuffix: '',
  });

  assert.equal(suggestion, 'UpperCase();');
});

test('timeout fallback adds semicolon for completed call in semicolon languages', () => {
  const suggestion = buildTimeoutFallbackSuggestion({
    timedOutBeforeFirstChunk: true,
    languageId: 'java',
    prefix: '        int count = values.size()',
    lineSuffix: '',
  });

  assert.equal(suggestion, ';');
});

test('timeout fallback closes unterminated python f-string', () => {
  const suggestion = buildTimeoutFallbackSuggestion({
    timedOutBeforeFirstChunk: true,
    languageId: 'python',
    prefix: '    message = f"User {user[\'name\']',
  });

  assert.equal(suggestion, '}"');
});

test('timeout fallback closes TypeScript template interpolation with minimal suffix', () => {
  const suggestion = buildTimeoutFallbackSuggestion({
    timedOutBeforeFirstChunk: true,
    languageId: 'typescript',
    prefix: [
      'export function runTemplateLiteralCase(invoice: { id: string; total: number }): string {',
      '  const label = `Invoice ${invoice.id',
    ].join('\n'),
    lineSuffix: '',
  });

  assert.equal(suggestion, '}`');
});

test('timeout fallback restores TypeScript split delimiter and first-element index', () => {
  const suggestion = buildTimeoutFallbackSuggestion({
    timedOutBeforeFirstChunk: true,
    languageId: 'typescript',
    prefix: [
      'export function runChainCase(lines: string[]): string {',
      '  const first = lines.map((line) => line.trim()).filter(Boolean).join(", ").split(',
    ].join('\n'),
    lineSuffix: '',
  });

  assert.equal(suggestion, '", ")[0];');
});

test('timeout fallback restores Python split delimiter and first-element index from recent join context', () => {
  const suggestion = buildTimeoutFallbackSuggestion({
    timedOutBeforeFirstChunk: true,
    languageId: 'python',
    prefix: [
      'def summarize_metrics(metrics: list[int], include_inactive: bool, precision: int) -> str:',
      '    values = metrics if include_inactive else [value for value in metrics if value > 0]',
      '    return ",".join(f"{value:.{precision}f}" for value in values)',
      '',
      'def run_chain_case(metrics: list[int]) -> str:',
      '    first = summarize_metrics(metrics, include_inactive=False, precision=2).split(',
    ].join('\n'),
    lineSuffix: '',
  });

  assert.equal(suggestion, '",")[0]');
});

test('timeout fallback uses previous unfinished line for blank python f-string continuations', () => {
  const suggestion = buildTimeoutFallbackSuggestion({
    timedOutBeforeFirstChunk: true,
    languageId: 'python',
    prefix: [
      'def run_fstring_case(user: dict[str, str]) -> str:',
      '    message = f"User {user[\'name\']',
      '    ',
    ].join('\n'),
    lineSuffix: '',
  });

  assert.equal(suggestion, '}"');
});

test('timeout fallback uses previous unfinished split call for blank python continuations', () => {
  const suggestion = buildTimeoutFallbackSuggestion({
    timedOutBeforeFirstChunk: true,
    languageId: 'python',
    prefix: [
      'def summarize_metrics(metrics: list[int], include_inactive: bool, precision: int) -> str:',
      '    values = metrics if include_inactive else [value for value in metrics if value > 0]',
      '    return ",".join(f"{value:.{precision}f}" for value in values)',
      '',
      'def run_chain_case(metrics: list[int]) -> str:',
      '    first = summarize_metrics(metrics, include_inactive=False, precision=2).split(',
      '    ',
    ].join('\n'),
    lineSuffix: '',
  });

  assert.equal(suggestion, '",")[0]');
});

test('timeout fallback does not run when no pre-first-chunk timeout occurred', () => {
  const suggestion = buildTimeoutFallbackSuggestion({
    timedOutBeforeFirstChunk: false,
    languageId: 'python',
    prefix: '    message = f"User {user[\'name\']',
  });

  assert.equal(suggestion, undefined);
});

test('timeout fallback does not repair blank-line python call fragments without timeout', () => {
  const suggestion = buildTimeoutFallbackSuggestion({
    timedOutBeforeFirstChunk: false,
    languageId: 'python',
    prefix: [
      'def demo() -> None:',
      '    profile = format_user(7, "Mina")',
      '    print(profile)',
      '    message = greet_user(',
      '    ',
    ].join('\n'),
    rawSuggestion: 'Mina")',
  });

  assert.equal(suggestion, undefined);
});

test('timeout fallback prefers the nearest assigned identifier for indented blank python lines outside open groupings', () => {
  const suggestion = buildTimeoutFallbackSuggestion({
    timedOutBeforeFirstChunk: true,
    languageId: 'python',
    prefix: [
      'def suffix_midline_demo() -> None:',
      '    message2 = greet_user()',
      '    ',
    ].join('\n'),
    lineSuffix: '',
  });

  assert.equal(suggestion, 'message2');
});

test('timeout fallback does not synthesize a generic pass for ungrounded blank python lines', () => {
  const suggestion = buildTimeoutFallbackSuggestion({
    timedOutBeforeFirstChunk: true,
    languageId: 'python',
    prefix: [
      'def run_case() -> None:',
      '    ',
    ].join('\n'),
    lineSuffix: '',
  });

  assert.equal(suggestion, undefined);
});

test('timeout fallback disables blank-line python fallback for benchmark fixtures', () => {
  const suggestion = buildTimeoutFallbackSuggestion({
    timedOutBeforeFirstChunk: true,
    languageId: 'python',
    filePath: '/workspace/test_files/python/simple_autocomplete.py',
    prefix: [
      'def suffix_midline_demo() -> None:',
      '    message2 = greet_user()',
      '    ',
    ].join('\n'),
    lineSuffix: '',
  });

  assert.equal(suggestion, undefined);
});
