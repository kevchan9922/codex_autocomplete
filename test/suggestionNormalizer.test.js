require('./helpers/registerVscode.js');

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeSuggestion } = require('../out/completion/suggestionNormalizer.js');

test('normalizeSuggestion applies built-in Python splitlines post-processor', () => {
  const result = normalizeSuggestion({
    suggestion: '())',
    prefix: 'def quick_check() -> str:\n    text = build_report(METRICS)\n    return text.splitlines(',
    suffix: '',
    languageId: 'python',
  });

  assert.equal(result.text, ')[0]');
  assert.equal(result.repairedFrom, '())');
});

test('normalizeSuggestion repairs splitlines index completions missing closing paren', () => {
  const result = normalizeSuggestion({
    suggestion: '[0]',
    prefix: 'def quick_check() -> str:\n    text = build_report(METRICS)\n    return text.splitlines(',
    suffix: '',
    languageId: 'python',
  });

  assert.equal(result.text, ')[0]');
  assert.equal(result.repairedFrom, '[0]');
});

test('normalizeSuggestion preserves Python split-index delimiter prefixes', () => {
  const result = normalizeSuggestion({
    suggestion: '",")[0]',
    prefix: 'def run_chain_case(metrics: list[int]) -> str:\n    first = summarize_metrics(metrics, include_inactive=False, precision=2).split(',
    suffix: '\n    return\n',
    languageId: 'python',
  });

  assert.equal(result.text, '",")[0]');
  assert.equal(result.repairedFrom, undefined);
});

test('normalizeSuggestion repairs escaped Python split-index noise', () => {
  const result = normalizeSuggestion({
    suggestion: '",\\")[0]',
    prefix: 'def run_chain_case(metrics: list[int]) -> str:\n    first = summarize_metrics(metrics, include_inactive=False, precision=2).split(',
    suffix: '\n    return\n',
    languageId: 'python',
  });

  assert.equal(result.text, '",")[0]');
  assert.equal(result.repairedFrom, '",\\")[0]');
});

test('normalizeSuggestion repairs duplicated Python split-index delimiter quote noise', () => {
  const result = normalizeSuggestion({
    suggestion: '","")[0]',
    prefix: 'def run_chain_case(metrics: list[int]) -> str:\n    first = summarize_metrics(metrics, include_inactive=False, precision=2).split(',
    suffix: '\n    return\n',
    languageId: 'python',
  });

  assert.equal(result.text, '",")[0]');
  assert.equal(result.repairedFrom, '","")[0]');
});

test('normalizeSuggestion repairs Python split-index spacing before close paren', () => {
  const result = normalizeSuggestion({
    suggestion: '"," )[0]',
    prefix: 'def run_chain_case(metrics: list[int]) -> str:\n    first = summarize_metrics(metrics, include_inactive=False, precision=2).split(',
    suffix: '\n    return\n',
    languageId: 'python',
  });

  assert.equal(result.text, '",")[0]');
  assert.equal(result.repairedFrom, '"," )[0]');
});

test('normalizeSuggestion repairs Python split-index stray quote after delimiter spacing', () => {
  const result = normalizeSuggestion({
    suggestion: '"," ")[0]',
    prefix: 'def run_chain_case(metrics: list[int]) -> str:\n    first = summarize_metrics(metrics, include_inactive=False, precision=2).split(',
    suffix: '\n    return\n',
    languageId: 'python',
  });

  assert.equal(result.text, '",")[0]');
  assert.equal(result.repairedFrom, '"," ")[0]');
});

test('normalizeSuggestion repairs truncated Python split-index completion missing the first-element index', () => {
  const result = normalizeSuggestion({
    suggestion: '",")',
    prefix: [
      'def summarize_metrics(metrics: list[int], include_inactive: bool, precision: int) -> str:',
      '    values = metrics if include_inactive else [value for value in metrics if value > 0]',
      '    return ",".join(f"{value:.{precision}f}" for value in values)',
      '',
      'def run_chain_case(metrics: list[int]) -> str:',
      '    first = summarize_metrics(metrics, include_inactive=False, precision=2).split(',
    ].join('\n'),
    suffix: '\n    return\n',
    languageId: 'python',
  });

  assert.equal(result.text, '",")[0]');
  assert.equal(result.repairedFrom, '",")');
});

test('normalizeSuggestion repairs minimal Python split-index closer using recent join context', () => {
  const result = normalizeSuggestion({
    suggestion: '")',
    prefix: [
      'def summarize_metrics(metrics: list[int], include_inactive: bool, precision: int) -> str:',
      '    values = metrics if include_inactive else [value for value in metrics if value > 0]',
      '    return ",".join(f"{value:.{precision}f}" for value in values)',
      '',
      'def run_chain_case(metrics: list[int]) -> str:',
      '    first = summarize_metrics(metrics, include_inactive=False, precision=2).split(',
    ].join('\n'),
    suffix: '\n    return\n',
    languageId: 'python',
  });

  assert.equal(result.text, '",")[0]');
  assert.equal(result.repairedFrom, '")');
});

test('normalizeSuggestion accepts custom post-processors', () => {
  const result = normalizeSuggestion({
    suggestion: 'return value',
    prefix: '',
    suffix: '',
    languageId: 'typescript',
    postProcessors: [
      (input) => `${input.suggestion};`,
    ],
  });

  assert.equal(result.text, 'return value;');
  assert.equal(result.repairedFrom, 'return value');
});

test('normalizeSuggestion repairs missing close-paren for Python call arguments', () => {
  const result = normalizeSuggestion({
    suggestion: '0.07',
    prefix: 'return total_with_tax_and_shipping(basket, coupon, ',
    suffix: '',
    languageId: 'python',
  });

  assert.equal(result.text, '0.07)');
  assert.equal(result.repairedFrom, '0.07');
});

test('normalizeSuggestion decodes escaped leading tab artifacts before trimming prefix overlap', () => {
  const result = normalizeSuggestion({
    suggestion: '\\treturn name',
    prefix: [
      'package main',
      '',
      'func maskedWordDemo() string {',
      '\tname := "Mina"',
      '\treturn nam',
    ].join('\n'),
    suffix: '\n}',
    linePrefix: '\treturn nam',
    lineSuffix: '',
    languageId: 'go',
  });

  assert.equal(result.text, 'e');
  assert.equal(result.repairedFrom, undefined);
});

test('normalizeSuggestion trims optional semicolon for TypeScript minimal closure', () => {
  const result = normalizeSuggestion({
    suggestion: ');',
    prefix: 'const payload = JSON.stringify(data',
    suffix: '',
    languageId: 'typescript',
  });

  assert.equal(result.text, ')');
  assert.equal(result.repairedFrom, ');');
});

test('normalizeSuggestion drops markdown fence-only suggestions so fallback logic can recover', () => {
  const result = normalizeSuggestion({
    suggestion: '```typescript\n```',
    prefix: 'const label = formatUser(',
    suffix: '\n',
    languageId: 'typescript',
  });

  assert.equal(result.text, '');
  assert.equal(result.repairedFrom, '```typescript\n```');
});

test('normalizeSuggestion keeps fence-only suggestions for markdown documents', () => {
  const result = normalizeSuggestion({
    suggestion: '```ts\n```',
    prefix: '# Notes\n\n',
    suffix: '',
    languageId: 'markdown',
  });

  assert.equal(result.text, '```ts\n```');
  assert.equal(result.repairedFrom, undefined);
});

test('normalizeSuggestion strips zero-width formatting artifacts from suggestions', () => {
  const result = normalizeSuggestion({
    suggestion: '\u200B\u200B',
    prefix: 'return total',
    suffix: '',
    languageId: 'typescript',
  });

  assert.equal(result.text, '');
  assert.equal(result.repairedFrom, '\u200B\u200B');
});

test('normalizeSuggestion appends guarded semicolon for TypeScript method-chain completion', () => {
  const result = normalizeSuggestion({
    suggestion: 'UpperCase()',
    prefix: 'const upper = person.name.to',
    suffix: '',
    languageId: 'typescript',
  });

  assert.equal(result.text, 'UpperCase();');
  assert.equal(result.repairedFrom, 'UpperCase()');
});

test('normalizeSuggestion closes TypeScript call and appends statement semicolon when safe', () => {
  const result = normalizeSuggestion({
    suggestion: '"P1"',
    prefix: 'return openPointsByPriority(',
    suffix: '',
    languageId: 'typescript',
  });

  assert.equal(result.text, '"P1");');
  assert.equal(result.repairedFrom, '"P1"');
});

test('normalizeSuggestion preserves minimal TypeScript suffix invocation without semicolon inflation', () => {
  const result = normalizeSuggestion({
    suggestion: '(person)',
    prefix: 'const label = formatUserName',
    suffix: '',
    languageId: 'typescript',
  });

  assert.equal(result.text, '(person)');
  assert.equal(result.repairedFrom, undefined);
});

test('normalizeSuggestion trims semicolon from TypeScript minimal suffix invocation', () => {
  const result = normalizeSuggestion({
    suggestion: '(person);',
    prefix: 'const label = formatUserName',
    suffix: '',
    languageId: 'typescript',
  });

  assert.equal(result.text, '(person)');
  assert.equal(result.repairedFrom, '(person);');
});

test('normalizeSuggestion keeps TypeScript return-chain suffix semicolon-free', () => {
  const result = normalizeSuggestion({
    suggestion: 'Case()',
    prefix: '  return first.toLower',
    suffix: '',
    languageId: 'typescript',
  });

  assert.equal(result.text, 'Case()');
  assert.equal(result.repairedFrom, undefined);
});

test('normalizeSuggestion dedupes Python f-string interpolation closure quotes', () => {
  const result = normalizeSuggestion({
    suggestion: '}""',
    prefix: 'def run(user: dict[str, str]) -> str:\n    message = f"User {user[\'name\']',
    suffix: '',
    languageId: 'python',
  });

  assert.equal(result.text, '}"');
  assert.equal(result.repairedFrom, '}""');
});

test('normalizeSuggestion closes Python f-string when model emits only the interpolation brace', () => {
  const result = normalizeSuggestion({
    suggestion: '}',
    prefix: 'def run(user: dict[str, str]) -> str:\n    message = f"User {user[\'name\']',
    suffix: '',
    languageId: 'python',
  });

  assert.equal(result.text, '}"');
  assert.equal(result.repairedFrom, '}');
});

test('normalizeSuggestion does not duplicate a Python f-string quote already present in the line suffix', () => {
  const result = normalizeSuggestion({
    suggestion: '}',
    prefix: 'def run(user: dict[str, str]) -> str:\n    message = f"User {user[\'name\']',
    suffix: '"\n    return message\n',
    lineSuffix: '"',
    languageId: 'python',
  });

  assert.equal(result.text, '}');
  assert.equal(result.repairedFrom, undefined);
});

test('normalizeSuggestion removes extra Python closer bracket before interpolation close', () => {
  const result = normalizeSuggestion({
    suggestion: ']}"',
    prefix: 'def run(user: dict[str, str]) -> str:\n    message = f"User {user[\'name\']',
    suffix: '',
    languageId: 'python',
  });

  assert.equal(result.text, '}"');
  assert.equal(result.repairedFrom, ']}"');
});

test('normalizeSuggestion preserves structural Python interpolation closer carryover on completed return lines', () => {
  const result = normalizeSuggestion({
    suggestion: '}"',
    prefix:
      'def run_fstring_case(user: dict[str, str]) -> str:\n'
      + '    message = f"User {user[\'name\']\n'
      + '    return message',
    suffix: '    \n',
    languageId: 'python',
  });

  assert.equal(result.text, '}"');
  assert.equal(result.repairedFrom, undefined);
});

test('normalizeSuggestion drops short identifier carryover on blank indented lines', () => {
  const result = normalizeSuggestion({
    suggestion: 'le',
    prefix:
      'def masked_word_demo() -> str:\n'
      + '    profile = format_user(7, "Mina")\n'
      + '    return profi\n'
      + '\n'
      + '\n'
      + 'if __name__ == "__main__":\n'
      + '    demo()\n'
      + '    ',
    suffix: '',
    languageId: 'python',
  });

  assert.equal(result.text, '');
  assert.equal(result.repairedFrom, 'le');
});

test('normalizeSuggestion drops short identifier carryover on truly empty blank lines', () => {
  const result = normalizeSuggestion({
    suggestion: 'le',
    prefix:
      'def masked_word_demo() -> str:\n'
      + '    profile = format_user(7, "Mina")\n'
      + '    return profi\n'
      + '\n'
      + '\n'
      + 'if __name__ == "__main__":\n'
      + '    demo()',
    suffix: '',
    linePrefix: '',
    lineSuffix: '',
    languageId: 'python',
  });

  assert.equal(result.text, '');
  assert.equal(result.repairedFrom, 'le');
});

test('normalizeSuggestion drops dangling literal fragment carryover on blank indented lines', () => {
  const result = normalizeSuggestion({
    suggestion: 'Mina")',
    prefix:
      'def masked_word_demo() -> str:\n'
      + '    profile = format_user(7, "Mina")\n'
      + '    return profi\n'
      + '\n'
      + '\n'
      + 'if __name__ == "__main__":\n'
      + '    demo()\n'
      + '    ',
    suffix: '',
    linePrefix: '    ',
    lineSuffix: '',
    languageId: 'python',
  });

  assert.equal(result.text, '');
  assert.equal(result.repairedFrom, 'Mina")');
});

test('normalizeSuggestion preserves valid blank-line statement suggestions', () => {
  const result = normalizeSuggestion({
    suggestion: 'pass',
    prefix: 'def run() -> None:\n    ',
    suffix: '',
    languageId: 'python',
  });

  assert.equal(result.text, 'pass');
  assert.equal(result.repairedFrom, undefined);
});

test('normalizeSuggestion preserves valid blank-line call statements', () => {
  const result = normalizeSuggestion({
    suggestion: 'print("Mina")',
    prefix: 'def run() -> None:\n    ',
    suffix: '',
    linePrefix: '    ',
    lineSuffix: '',
    languageId: 'python',
  });

  assert.equal(result.text, 'print("Mina")');
  assert.equal(result.repairedFrom, undefined);
});

test('normalizeSuggestion preserves repeated blank-line call statements with complete arguments', () => {
  const result = normalizeSuggestion({
    suggestion: 'lines.append("")',
    prefix: [
      'def build_report(metrics: list[DailyMetric]) -> str:',
      '    lines = ["Weekly KPI report", "-----------------"]',
      '    for metric in metrics:',
      '        lines.append(summarize_day(metric))',
      '',
      '    lines.append("")',
      '        ',
    ].join('\n'),
    suffix: [
      '    lines.append(f"Activation avg: {weekly_activation_average(metrics):.2%}")',
      '    lines.append(f"Retention avg: {weekly_retention_average(metrics):.2%}")',
      '    return "\\n".join(lines)',
    ].join('\n'),
    linePrefix: '        ',
    lineSuffix: '',
    languageId: 'python',
  });

  assert.equal(result.text, 'lines.append("")');
  assert.equal(result.repairedFrom, undefined);
  assert.equal(result.repairReasons, undefined);
});

test('normalizeSuggestion drops blank-line argument carryover fragments', () => {
  const result = normalizeSuggestion({
    suggestion: '10, "',
    prefix: 'def run_keyword_args_case() -> Query:\n    filters = {"active": True, "country": "US"}\n    ',
    suffix: '    query = build_query("users", filters, \n    return query\n',
    linePrefix: '    ',
    lineSuffix: '',
    languageId: 'python',
  });

  assert.equal(result.text, '');
  assert.equal(result.repairedFrom, '10, "');
});

test('normalizeSuggestion preserves blank-line member suffix continuation when it completes current token', () => {
  const result = normalizeSuggestion({
    suggestion: 'per()',
    prefix:
      'def case_suffix_only(values: Iterable[str]) -> str:\n'
      + '    first = next(iter(values), "none")\n'
      + '    ',
    suffix: '    return first.up\n',
    linePrefix: '    ',
    lineSuffix: '',
    languageId: 'python',
  });

  assert.equal(result.text, 'per()');
  assert.equal(result.repairedFrom, undefined);
});

test('normalizeSuggestion preserves blank-line call statements when later suffix lines are unrelated', () => {
  const result = normalizeSuggestion({
    suggestion: 'print("Mina")',
    prefix: 'def run() -> None:\n    ',
    suffix: '    return message\n',
    linePrefix: '    ',
    lineSuffix: '',
    languageId: 'python',
  });

  assert.equal(result.text, 'print("Mina")');
  assert.equal(result.repairedFrom, undefined);
});

test('normalizeSuggestion reports the placeholder-drop repair reason for generic blank-line pass', () => {
  const result = normalizeSuggestion({
    suggestion: 'pass',
    prefix: 'def run_fstring_case(user: dict[str, str]) -> str:\n    ',
    suffix: '    return message\n',
    linePrefix: '    ',
    lineSuffix: '',
    languageId: 'python',
  });

  assert.equal(result.text, '');
  assert.equal(result.repairedFrom, 'pass');
  assert.deepEqual(result.repairReasons, ['dropGenericBlankLinePlaceholder']);
});

test('normalizeSuggestion keeps blank-line return placeholders when the suffix continues with another statement', () => {
  const result = normalizeSuggestion({
    suggestion: 'return;',
    prefix: [
      'static void RunDemo()',
      '{',
      '    var normalized = "Mina";',
      '    var message = Welcome(normalized);',
      '    ',
    ].join('\n'),
    suffix: '    Console.WriteLine(message);\n}\n',
    linePrefix: '    ',
    lineSuffix: '',
    languageId: 'csharp',
  });

  assert.equal(result.text, 'return;');
  assert.equal(result.repairedFrom, undefined);
  assert.equal(result.repairReasons, undefined);
});

test('normalizeSuggestion keeps typed member declarations invented on blank spacer lines', () => {
  const result = normalizeSuggestion({
    suggestion: 'user_age: i32,',
    prefix: [
      'struct Profile {',
      '    user_id: i32,',
      '    user_name: String,',
      '    ',
    ].join('\n'),
    suffix: '}\n',
    linePrefix: '    ',
    lineSuffix: '',
    languageId: 'rust',
  });

  assert.equal(result.text, 'user_age: i32,');
  assert.equal(result.repairedFrom, undefined);
  assert.equal(result.repairReasons, undefined);
});

test('normalizeSuggestion dedupes template interpolation closure and avoids semicolon inflation', () => {
  const result = normalizeSuggestion({
    suggestion: '}``;',
    prefix: 'export function run(invoice: { id: string }): string {\n  const label = `Invoice ${invoice.id',
    suffix: '',
    languageId: 'typescript',
  });

  assert.equal(result.text, '}`');
  assert.equal(result.repairedFrom, '}``;');
});

test('normalizeSuggestion collapses duplicated C# method-chain suffix overlap', () => {
  const result = normalizeSuggestion({
    suggestion: 'r();rInvariant();',
    prefix: 'return value.Trim().ToLowe',
    suffix: '',
    languageId: 'csharp',
  });

  assert.equal(result.text, 'rInvariant();');
  assert.equal(result.repairedFrom, 'r();rInvariant();');
});

test('normalizeSuggestion trims guarded single-char overlap for member suffix continuation', () => {
  const result = normalizeSuggestion({
    suggestion: 'wer(value)',
    prefix: 'return strings.ToLow',
    suffix: '',
    languageId: 'go',
  });

  assert.equal(result.text, 'er(value)');
  assert.equal(result.repairedFrom, undefined);
});

test('normalizeSuggestion trims guarded single-char overlap for lowercase member suffix continuation', () => {
  const result = normalizeSuggestion({
    suggestion: 'wer()',
    prefix: 'return message.strip().low',
    suffix: '',
    languageId: 'python',
  });

  assert.equal(result.text, 'er()');
  assert.equal(result.repairedFrom, undefined);
});

test('normalizeSuggestion repairs escaped TypeScript split-index noise', () => {
  const result = normalizeSuggestion({
    suggestion: '", \\")[0];"',
    prefix: 'export function run(lines: string[]): string {\n  const first = lines.join(", ").split(',
    suffix: '\n  return first;\n}',
    languageId: 'typescript',
  });

  assert.equal(result.text, '", ")[0];');
  assert.equal(result.repairedFrom, '", \\")[0];"');
});

test('normalizeSuggestion repairs Rust vec bracket closure with semicolon', () => {
  const result = normalizeSuggestion({
    suggestion: ']',
    prefix: 'fn vec_demo() -> Vec<i32> {\n    let values = vec![1, 2, 3',
    suffix: '\n    values\n}',
    languageId: 'rust',
  });

  assert.equal(result.text, '];');
  assert.equal(result.repairedFrom, ']');
});
