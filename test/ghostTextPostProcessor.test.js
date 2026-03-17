const test = require('node:test');
const assert = require('node:assert/strict');

const {
  postProcessGhostTextSuggestion,
} = require('../out/completion/ghostTextPostProcessor.js');

test('postProcessGhostTextSuggestion drops duplicated blank-line suffix suggestions when no grounded fallback exists', () => {
  const result = postProcessGhostTextSuggestion({
    suggestion: 'return Query(table=table, filters=filters, limit=limit, order_by=order_by)',
    timedOutBeforeFirstChunk: true,
    prefix: 'def build_query(table: str, filters: dict[str, Any], limit: int, order_by: str) -> Query:\n    ',
    suffix: '    \n    #      \n    return Query(table=table, filters=filters, limit=limit, order_by=order_by)\n',
    linePrefix: '    ',
    lineSuffix: '',
    languageId: 'python',
  });

  assert.equal(result.text, '');
  assert.ok(
    result.droppedDuplicateLaterSuffixLine
    || result.repairReasons?.includes('dropGenericBlankLinePlaceholder'),
  );
  assert.equal(result.timeoutFallback, undefined);
});

test('postProcessGhostTextSuggestion keeps blank-line suggestions when the first meaningful suffix line differs', () => {
  const result = postProcessGhostTextSuggestion({
    suggestion: 'query = build_query("users", filters, 25, order_by="created_at")',
    timedOutBeforeFirstChunk: false,
    prefix: 'def run_keyword_args_case() -> Query:\n    filters = {"active": True}\n    ',
    suffix: '    # fill this in\n    return query\n',
    linePrefix: '    ',
    lineSuffix: '',
    languageId: 'python',
  });

  assert.equal(result.text, 'query = build_query("users", filters, 25, order_by="created_at")');
  assert.equal(result.droppedDuplicateLaterSuffixLine, false);
});

test('postProcessGhostTextSuggestion repairs empty template interpolation closures', () => {
  const result = postProcessGhostTextSuggestion({
    suggestion: '',
    timedOutBeforeFirstChunk: true,
    prefix: [
      'export function runTemplateLiteralCase(invoice: { id: string; total: number }): string {',
      '  const label = `Invoice ${invoice.id',
    ].join('\n'),
    suffix: '\n  return label;\n}\n',
    linePrefix: '  const label = `Invoice ${invoice.id',
    lineSuffix: '',
    languageId: 'typescript',
  });

  assert.equal(result.text, '}`');
  assert.equal(result.timeoutFallback, '}`');
});

test('postProcessGhostTextSuggestion repairs empty split-index completions', () => {
  const result = postProcessGhostTextSuggestion({
    suggestion: '',
    timedOutBeforeFirstChunk: true,
    prefix: [
      'export function runChainCase(lines: string[]): string {',
      '  const first = lines.map((line) => line.trim()).filter(Boolean).join(", ").split(',
    ].join('\n'),
    suffix: '\n  return first;\n}\n',
    linePrefix: '  const first = lines.map((line) => line.trim()).filter(Boolean).join(", ").split(',
    lineSuffix: '',
    languageId: 'typescript',
  });

  assert.equal(result.text, '", ")[0];');
  assert.equal(result.timeoutFallback, '", ")[0];');
});

test('postProcessGhostTextSuggestion falls back when model emits fence-only placeholder text', () => {
  const result = postProcessGhostTextSuggestion({
    suggestion: '```typescript\n```',
    timedOutBeforeFirstChunk: true,
    prefix: [
      'export function runChainCase(lines: string[]): string {',
      '  const first = lines.map((line) => line.trim()).filter(Boolean).join(", ").split(',
    ].join('\n'),
    suffix: '\n  return first;\n}\n',
    linePrefix: '  const first = lines.map((line) => line.trim()).filter(Boolean).join(", ").split(',
    lineSuffix: '',
    languageId: 'typescript',
  });

  assert.equal(result.text, '", ")[0];');
  assert.equal(result.repairedFrom, '```typescript\n```');
  assert.equal(result.timeoutFallback, '", ")[0];');
});

test('postProcessGhostTextSuggestion repairs blank-line call fragments with a missing opening quote', () => {
  const result = postProcessGhostTextSuggestion({
    suggestion: 'Mina")',
    timedOutBeforeFirstChunk: false,
    prefix: [
      'def demo() -> None:',
      '    profile = format_user(7, "Mina")',
      '    print(profile)',
      '    message = greet_user(',
      '    ',
    ].join('\n'),
    suffix: '',
    linePrefix: '    ',
    lineSuffix: '',
    languageId: 'python',
  });

  assert.equal(result.text, '"Mina")');
  assert.equal(result.repairedFrom, 'Mina")');
  assert.equal(result.timeoutFallback, undefined);
});

test('postProcessGhostTextSuggestion preserves structural f-string closers on blank continuation lines', () => {
  const result = postProcessGhostTextSuggestion({
    suggestion: '}"',
    timedOutBeforeFirstChunk: false,
    prefix: [
      'def run_fstring_case(user: dict[str, str]) -> str:',
      '    message = f"User {user[\'name\']',
      '    ',
    ].join('\n'),
    suffix: '    return message\n',
    linePrefix: '    ',
    lineSuffix: '',
    languageId: 'python',
  });

  assert.equal(result.text, '}"');
  assert.equal(result.timeoutFallback, undefined);
});

test('postProcessGhostTextSuggestion repairs split-index truncation on blank continuation lines', () => {
  const result = postProcessGhostTextSuggestion({
    suggestion: '")',
    timedOutBeforeFirstChunk: false,
    prefix: [
      'def summarize_metrics(metrics: list[int], include_inactive: bool, precision: int) -> str:',
      '    values = metrics if include_inactive else [value for value in metrics if value > 0]',
      '    return ",".join(f"{value:.{precision}f}" for value in values)',
      '',
      'def run_chain_case(metrics: list[int]) -> str:',
      '    first = summarize_metrics(metrics, include_inactive=False, precision=2).split(',
      '    ',
    ].join('\n'),
    suffix: '    return first\n',
    linePrefix: '    ',
    lineSuffix: '',
    languageId: 'python',
  });

  assert.equal(result.text, '",")[0]');
  assert.equal(result.repairedFrom, '")');
  assert.equal(result.timeoutFallback, undefined);
});

test('postProcessGhostTextSuggestion keeps spacer lines empty after dropping a duplicated later suffix line', () => {
  const result = postProcessGhostTextSuggestion({
    suggestion: 'print(message2)',
    timedOutBeforeFirstChunk: true,
    prefix: [
      'def suffix_midline_demo() -> None:',
      '    message2 = greet_user()',
      '    ',
    ].join('\n'),
    suffix: '    print(message2)\n',
    linePrefix: '    ',
    lineSuffix: '',
    languageId: 'python',
  });

  assert.equal(result.text, '');
  assert.equal(result.timeoutFallback, undefined);
  assert.ok(
    result.droppedDuplicateLaterSuffixLine
    || result.repairReasons?.includes('dropGenericBlankLinePlaceholder'),
  );
});

test('postProcessGhostTextSuggestion drops duplicated later suffix lines when spacing differs', () => {
  const result = postProcessGhostTextSuggestion({
    suggestion: 'return  Query(table = table, filters=filters, limit = limit, order_by = order_by)',
    timedOutBeforeFirstChunk: true,
    prefix: 'def build_query(table: str, filters: dict[str, Any], limit: int, order_by: str) -> Query:\n    ',
    suffix: '    return Query(table=table, filters=filters, limit=limit, order_by=order_by)\n',
    linePrefix: '    ',
    lineSuffix: '',
    languageId: 'python',
  });

  assert.equal(result.text, '');
  assert.equal(result.droppedDuplicateLaterSuffixLine, true);
});

test('postProcessGhostTextSuggestion drops duplicated later suffix lines when tabs differ', () => {
  const result = postProcessGhostTextSuggestion({
    suggestion: 'return\tQuery(table=table,\tfilters=filters,\tlimit=limit,\torder_by=order_by)',
    timedOutBeforeFirstChunk: true,
    prefix: 'def build_query(table: str, filters: dict[str, Any], limit: int, order_by: str) -> Query:\n    ',
    suffix: '    return Query(table=table, filters=filters, limit=limit, order_by=order_by)\n',
    linePrefix: '    ',
    lineSuffix: '',
    languageId: 'python',
  });

  assert.equal(result.text, '');
  assert.equal(result.droppedDuplicateLaterSuffixLine, true);
});

test('postProcessGhostTextSuggestion keeps spacer lines empty after dropping blank-line argument carryover', () => {
  const result = postProcessGhostTextSuggestion({
    suggestion: '10, "',
    timedOutBeforeFirstChunk: true,
    prefix: [
      'def run_keyword_args_case() -> Query:',
      '    filters = {"active": True, "country": "US"}',
      '    ',
    ].join('\n'),
    suffix: '    query = build_query("users", filters, \n    return query\n',
    linePrefix: '    ',
    lineSuffix: '',
    languageId: 'python',
  });

  assert.equal(result.text, '');
  assert.equal(result.repairedFrom, '10, "');
  assert.equal(result.timeoutFallback, undefined);
});

test('postProcessGhostTextSuggestion keeps copied previous statements on blank spacer lines', () => {
  const result = postProcessGhostTextSuggestion({
    suggestion: 'var status = FormatStatus(',
    timedOutBeforeFirstChunk: false,
    prefix: [
      'static string CaseCallCompletion(string user)',
      '{',
      '    var status = FormatStatus(',
      '    user, true);',
      '    ',
    ].join('\n'),
    suffix: '    return status;\n}\n',
    linePrefix: '    ',
    lineSuffix: '',
    languageId: 'csharp',
  });

  assert.equal(result.text, 'var status = FormatStatus(');
  assert.equal(result.repairedFrom, undefined);
});

test('postProcessGhostTextSuggestion keeps assignments to ambiguous near-duplicate return identifiers on blank spacer lines', () => {
  const result = postProcessGhostTextSuggestion({
    suggestion: 'report_s = report_summary',
    timedOutBeforeFirstChunk: false,
    prefix: [
      'def near_duplicate_suffix_case(metrics: list[str]) -> str:',
      '    report = build_report(metrics)',
      '    report_text = report',
      '    report_summary = report.splitlines()[0]',
      '    ',
    ].join('\n'),
    suffix: '    return report_s\n',
    linePrefix: '    ',
    lineSuffix: '',
    languageId: 'python',
  });

  assert.equal(result.text, 'report_s = report_summary');
  assert.equal(result.repairedFrom, undefined);
});

test('postProcessGhostTextSuggestion exposes repair reasons for dropped generic blank-line pass placeholders', () => {
  const result = postProcessGhostTextSuggestion({
    suggestion: 'pass',
    timedOutBeforeFirstChunk: false,
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

test('postProcessGhostTextSuggestion keeps bare return placeholders on blank spacer lines', () => {
  const result = postProcessGhostTextSuggestion({
    suggestion: 'return;',
    timedOutBeforeFirstChunk: false,
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
});

test('postProcessGhostTextSuggestion keeps return value statements on blank spacer lines', () => {
  const result = postProcessGhostTextSuggestion({
    suggestion: 'return message;',
    timedOutBeforeFirstChunk: false,
    prefix: [
      'function runDemo() {',
      '  const normalized = titleCase("sAm lee");',
      '  const message = welcome(normalized);',
      '  ',
    ].join('\n'),
    suffix: '  console.log(message);\n}\n',
    linePrefix: '  ',
    lineSuffix: '',
    languageId: 'javascript',
  });

  assert.equal(result.text, 'return message;');
  assert.equal(result.repairedFrom, undefined);
});

test('postProcessGhostTextSuggestion keeps punctuation-only carryover on blank spacer lines', () => {
  const result = postProcessGhostTextSuggestion({
    suggestion: ';',
    timedOutBeforeFirstChunk: false,
    prefix: [
      'static List<int> GenericListDemo()',
      '{',
      '    var ids = new List<int',
      '    ',
    ].join('\n'),
    suffix: '    return ids;\n}\n',
    linePrefix: '    ',
    lineSuffix: '',
    languageId: 'csharp',
  });

  assert.equal(result.text, ';');
  assert.equal(result.repairedFrom, undefined);
});

test('postProcessGhostTextSuggestion keeps suffix-only identifier usage on blank spacer lines', () => {
  const result = postProcessGhostTextSuggestion({
    suggestion: 'System.out.println(summary);',
    timedOutBeforeFirstChunk: false,
    prefix: [
      'public class CrossFileConsumer {',
      '    public static void main(String[] args) {',
      '        String fullName = SimpleAutocomplete.formatName("Ada", "Lovelace");',
      '        String greeting = SimpleAutocomplete.greet(fullName);',
      '        System.out.println(greeting);',
      '        ',
    ].join('\n'),
    suffix: '        String summary = LargeAutocomplete.summarizeMetric(\n    }\n}\n',
    linePrefix: '        ',
    lineSuffix: '',
    languageId: 'java',
  });

  assert.equal(result.text, 'System.out.println(summary);');
  assert.equal(result.repairedFrom, undefined);
});

test('postProcessGhostTextSuggestion keeps typed member declarations on blank spacer lines', () => {
  const result = postProcessGhostTextSuggestion({
    suggestion: 'user_age: i32,',
    timedOutBeforeFirstChunk: false,
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
});

test('postProcessGhostTextSuggestion keeps unused declarations on blank spacer lines', () => {
  const result = postProcessGhostTextSuggestion({
    suggestion: 'const result = status.toLowerCase();',
    timedOutBeforeFirstChunk: false,
    prefix: [
      'export function caseCallCompletion(user: string): string {',
      '  const status = formatStatus(user, true);',
      '  ',
    ].join('\n'),
    suffix: '  return status;\n}\n',
    linePrefix: '  ',
    lineSuffix: '',
    languageId: 'typescript',
  });

  assert.equal(result.text, 'const result = status.toLowerCase();');
  assert.equal(result.repairedFrom, undefined);
});

test('postProcessGhostTextSuggestion keeps ungrounded expression statements on blank spacer lines', () => {
  const result = postProcessGhostTextSuggestion({
    suggestion: 'status.toLowerCase();',
    timedOutBeforeFirstChunk: false,
    prefix: [
      'export function caseCallCompletion(user: string): string {',
      '  const status = formatStatus(user, true);',
      '  const result = status.toLowerCase();',
      '  ',
    ].join('\n'),
    suffix: '  return status;\n}\n',
    linePrefix: '  ',
    lineSuffix: '',
    languageId: 'typescript',
  });

  assert.equal(result.text, 'status.toLowerCase();');
  assert.equal(result.repairedFrom, undefined);
});

test('postProcessGhostTextSuggestion keeps grounded logging statements on blank spacer lines', () => {
  const result = postProcessGhostTextSuggestion({
    suggestion: 'console.log(payload);',
    timedOutBeforeFirstChunk: false,
    prefix: [
      'export function stringifyPayload(data: Record<string, unknown>): string {',
      '  const payload = JSON.stringify(data);',
      '  ',
    ].join('\n'),
    suffix: '  return payload;\n}\n',
    linePrefix: '  ',
    lineSuffix: '',
    languageId: 'javascript',
  });

  assert.equal(result.text, 'console.log(payload);');
  assert.equal(result.repairedFrom, undefined);
});

test('postProcessGhostTextSuggestion keeps invented json properties on blank spacer lines', () => {
  const result = postProcessGhostTextSuggestion({
    suggestion: '"next_line_text": ""',
    timedOutBeforeFirstChunk: false,
    prefix: [
      '[',
      '  {',
      '    "cursor_line": 6,',
      '    "cursor_char": 1,',
      '    ',
    ].join('\n'),
    suffix: '    "row_tags": ["markdown", "blank_line", "structure"]\n  }\n]\n',
    linePrefix: '    ',
    lineSuffix: '',
    languageId: 'json',
  });

  assert.equal(result.text, '"next_line_text": ""');
  assert.equal(result.repairedFrom, undefined);
});

test('postProcessGhostTextSuggestion keeps invented go struct fields on blank spacer lines', () => {
  const result = postProcessGhostTextSuggestion({
    suggestion: 'LastLogin int',
    timedOutBeforeFirstChunk: false,
    prefix: [
      'type User struct {',
      '\tFirstName  string',
      '\tFirstLogin int',
      '\t',
    ].join('\n'),
    suffix: '}\n',
    linePrefix: '\t',
    lineSuffix: '',
    languageId: 'go',
  });

  assert.equal(result.text, 'LastLogin int');
  assert.equal(result.repairedFrom, undefined);
});

test('postProcessGhostTextSuggestion keeps invented csharp auto-properties on blank spacer lines', () => {
  const result = postProcessGhostTextSuggestion({
    suggestion: 'public string ZipCode { get; set; } = "";',
    timedOutBeforeFirstChunk: false,
    prefix: [
      'public class Address',
      '{',
      '    public string City { get; set; } = "Seattle";',
      '    public string Country { get; set; } = "USA";',
      '    ',
    ].join('\n'),
    suffix: '}\n',
    linePrefix: '    ',
    lineSuffix: '',
    languageId: 'csharp',
  });

  assert.equal(result.text, 'public string ZipCode { get; set; } = "";');
  assert.equal(result.repairedFrom, undefined);
});

test('postProcessGhostTextSuggestion drops comment placeholders on blank spacer lines', () => {
  const result = postProcessGhostTextSuggestion({
    suggestion: '// TODO',
    timedOutBeforeFirstChunk: false,
    prefix: [
      'static String formatName(String first, String last) {',
      '        ',
    ].join('\n'),
    suffix: '        return first + " " + last;\n    }\n',
    linePrefix: '        ',
    lineSuffix: '',
    languageId: 'java',
  });

  assert.equal(result.text, '');
  assert.equal(result.repairedFrom, '// TODO');
  assert.ok(result.repairReasons?.includes('dropGenericBlankLinePlaceholder'));
});

test('postProcessGhostTextSuggestion preserves declarations used later in the same block after nested statements', () => {
  const result = postProcessGhostTextSuggestion({
    suggestion: 'const summary = buildSummary(status);',
    timedOutBeforeFirstChunk: false,
    prefix: [
      'export function renderStatus(status: string): string {',
      '  const title = formatTitle(status);',
      '  ',
    ].join('\n'),
    suffix: [
      '  if (debugMode) {',
      '    console.log(title);',
      '  }',
      '  send(summary);',
      '  return summary;',
      '}',
    ].join('\n'),
    linePrefix: '  ',
    lineSuffix: '',
    languageId: 'typescript',
  });

  assert.equal(result.text, 'const summary = buildSummary(status);');
  assert.equal(result.repairedFrom, undefined);
});

test('postProcessGhostTextSuggestion preserves grounded literal-free side-effect calls on blank spacer lines', () => {
  const result = postProcessGhostTextSuggestion({
    suggestion: 'builder.flush();',
    timedOutBeforeFirstChunk: false,
    prefix: [
      'export function finish(builder: ReportBuilder): string {',
      '  builder.appendLine(header);',
      '  ',
    ].join('\n'),
    suffix: [
      '  builder.close();',
      '  return builder.output();',
      '}',
    ].join('\n'),
    linePrefix: '  ',
    lineSuffix: '',
    languageId: 'typescript',
  });

  assert.equal(result.text, 'builder.flush();');
  assert.equal(result.repairedFrom, undefined);
});

test('postProcessGhostTextSuggestion keeps explicit logging calls even when they include literals', () => {
  const result = postProcessGhostTextSuggestion({
    suggestion: 'console.log("debug");',
    timedOutBeforeFirstChunk: false,
    prefix: [
      'export function stringifyPayload(data: Record<string, unknown>): string {',
      '  const payload = JSON.stringify(data);',
      '  ',
    ].join('\n'),
    suffix: '  return payload;\n}\n',
    linePrefix: '  ',
    lineSuffix: '',
    languageId: 'javascript',
  });

  assert.equal(result.text, 'console.log("debug");');
  assert.equal(result.repairedFrom, undefined);
});

test('postProcessGhostTextSuggestion does not use blank-line timeout fallback for benchmark fixtures', () => {
  const result = postProcessGhostTextSuggestion({
    suggestion: '',
    timedOutBeforeFirstChunk: true,
    prefix: [
      'def suffix_midline_demo() -> None:',
      '    message2 = greet_user()',
      '    ',
    ].join('\n'),
    suffix: '    print(message2)\n',
    filePath: '/workspace/test_files/python/simple_autocomplete.py',
    linePrefix: '    ',
    lineSuffix: '',
    languageId: 'python',
  });

  assert.equal(result.text, '');
  assert.equal(result.timeoutFallback, undefined);
});
