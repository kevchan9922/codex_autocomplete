require('./helpers/registerVscode.js');

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildCompletionContext,
  createContextHash,
} = require('../out/completion/contextBuilder.js');

test('context includes before/after/selection/language/path', () => {
  const result = buildCompletionContext(
    {
      text: ['a', 'b', 'c', 'd', 'e'].join('\n'),
      languageId: 'typescript',
      filePath: '/workspace/file.ts',
      selection: 'selectedText',
    },
    { line: 2, character: 0 },
    {
      maxBeforeLines: 2,
      maxAfterLines: 2,
      maxContextChars: 200,
      maxFileLines: 5000,
    },
  );

  assert.equal(result.skip, false);
  const { context } = result;
  assert.deepEqual(context.beforeLines, ['a', 'b']);
  assert.deepEqual(context.afterLines, ['c', 'd']);
  assert.equal(context.selection, 'selectedText');
  assert.equal(context.languageId, 'typescript');
  assert.equal(context.filePath, '/workspace/file.ts');
});

test('truncation removes oldest prefix first to satisfy max chars', () => {
  const result = buildCompletionContext(
    {
      text: ['11111', '22222', '33333', '44444'].join('\n'),
      languageId: 'plaintext',
      filePath: '/workspace/file.txt',
      selection: 'SELECTION',
    },
    { line: 4, character: 0 },
    {
      maxBeforeLines: 4,
      maxAfterLines: 0,
      maxContextChars: 21,
      maxFileLines: 5000,
    },
  );

  assert.equal(result.skip, false);
  const { context } = result;
  assert.equal(context.truncated, true);
  assert.deepEqual(context.beforeLines, ['33333', '44444']);
});

test('context splits current line at cursor character', () => {
  const result = buildCompletionContext(
    {
      text: 'before\nplanner.add_task("\nafter',
      languageId: 'python',
      filePath: '/workspace/file.py',
    },
    { line: 1, character: 18 },
    {
      maxBeforeLines: 5,
      maxAfterLines: 5,
      maxContextChars: 500,
      maxFileLines: 5000,
    },
  );

  assert.equal(result.skip, false);
  const { context } = result;
  assert.deepEqual(context.beforeLines, ['before', 'planner.add_task("']);
  assert.deepEqual(context.afterLines, ['after']);
});

test('files over max line limit still return local truncated context', () => {
  const largeText = Array.from({ length: 5001 }, (_, index) => `line-${index}`).join('\n');
  const result = buildCompletionContext(
    {
      text: largeText,
      languageId: 'plaintext',
      filePath: '/workspace/huge.txt',
    },
    { line: 4, character: 0 },
    {
      maxBeforeLines: 200,
      maxAfterLines: 20,
      maxContextChars: 12000,
      maxFileLines: 5000,
    },
  );

  assert.equal(result.skip, false);
  assert.equal(result.lineCount, 5001);
  assert.equal(result.truncatedForFileSize, true);
  assert.equal(result.context.beforeLines[result.context.beforeLines.length - 1], 'line-3');
  assert.equal(result.context.afterLines[0], 'line-4');
});

test('blank line positions preserve same-line prefix and empty suffix', () => {
  const result = buildCompletionContext(
    {
      text: ['def run() -> str:', '    value = "ok"', '    ', '    return value'].join('\n'),
      languageId: 'python',
      filePath: '/workspace/file.py',
    },
    { line: 2, character: 4 },
    {
      maxBeforeLines: 200,
      maxAfterLines: 20,
      maxContextChars: 12000,
      maxFileLines: 5000,
    },
  );

  assert.equal(result.skip, false);
  const { context } = result;
  assert.equal(context.linePrefix, '    ');
  assert.equal(context.lineSuffix, '');
  assert.deepEqual(context.afterLines, ['    return value']);
});

test('context hash is deterministic for same input', () => {
  const input = {
    beforeLines: ['alpha', 'beta'],
    afterLines: ['gamma'],
    selection: 'sel',
    languageId: 'typescript',
    filePath: '/workspace/file.ts',
    cursor: { line: 10, character: 4 },
  };

  const hashA = createContextHash(input);
  const hashB = createContextHash(input);

  assert.equal(hashA, hashB);
});

test('context splits current line at cursor character', () => {
  const result = buildCompletionContext(
    {
      text: [
        'def quick_check() -> str:',
        '    text = build_report(METRICS)',
        '    return text.splitlines(',
        '    pass',
      ].join('\n'),
      languageId: 'python',
      filePath: '/workspace/large_autocomplete.py',
    },
    { line: 2, character: 27 },
    {
      maxBeforeLines: 60,
      maxAfterLines: 20,
      maxContextChars: 6000,
      maxFileLines: 5000,
    },
  );

  assert.equal(result.skip, false);
  const { context } = result;
  assert.equal(
    context.prefix.split('\n').pop(),
    '    return text.splitlines(',
  );
  assert.equal(
    context.suffix.split('\n')[0],
    '    pass',
  );
});
