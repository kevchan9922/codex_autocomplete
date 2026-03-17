require('./helpers/registerVscode.js');

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildPromptCacheKey } = require('../out/completion/promptCacheKey.js');

test('buildPromptCacheKey is deterministic and includes language/repo hints', () => {
  const context = {
    beforeLines: ['function runTask() {', '  return runner('],
    afterLines: [');', '}'],
    selection: '',
    languageId: 'typescript',
    filePath: '/workspace/codex_autocomplete/src/file.ts',
    cursor: { line: 11, character: 3 },
    prefix: '',
    suffix: '',
    truncated: false,
  };

  const first = buildPromptCacheKey('Codex Autocomplete', context);
  const second = buildPromptCacheKey('Codex Autocomplete', context);

  assert.equal(first, second);
  assert.match(first, /^codex-autocomplete:src:typescript:runner:[a-f0-9]{8}$/);
});

test('buildPromptCacheKey falls back to global symbol hint when no symbol is found', () => {
  const key = buildPromptCacheKey(undefined, {
    beforeLines: ['   ', 'const x = 1;'],
    afterLines: [],
    selection: '',
    languageId: 'python',
    filePath: '/tmp/example.py',
    cursor: { line: 1, character: 0 },
    prefix: '',
    suffix: '',
    truncated: false,
  });

  assert.match(key, /^codex-autocomplete:tmp:python:global:[a-f0-9]{8}$/);
});

test('buildPromptCacheKey stays stable for nearby text edits in same file/symbol', () => {
  const baseContext = {
    beforeLines: ['function runTask() {', '  return runner('],
    afterLines: [');', '}'],
    selection: '',
    languageId: 'typescript',
    filePath: '/workspace/codex_autocomplete/src/file.ts',
    cursor: { line: 21, character: 3 },
    prefix: '',
    suffix: '',
    truncated: false,
  };
  const editedContext = {
    ...baseContext,
    beforeLines: ['function runTask() {', '  const noisy = compute();', '  return runner('],
    afterLines: ['); // trailing note', '}'],
    cursor: { line: 23, character: 8 },
  };

  const baseKey = buildPromptCacheKey('Codex Autocomplete', baseContext);
  const editedKey = buildPromptCacheKey('Codex Autocomplete', editedContext);

  assert.equal(baseKey, editedKey);
});

test('buildPromptCacheKey changes across file path even when language/symbol are same', () => {
  const first = buildPromptCacheKey('Codex Autocomplete', {
    beforeLines: ['function runTask() {', '  return runner('],
    afterLines: [');', '}'],
    selection: '',
    languageId: 'typescript',
    filePath: '/workspace/codex_autocomplete/src/fileA.ts',
    cursor: { line: 21, character: 3 },
    prefix: '',
    suffix: '',
    truncated: false,
  });
  const second = buildPromptCacheKey('Codex Autocomplete', {
    beforeLines: ['function runTask() {', '  return runner('],
    afterLines: [');', '}'],
    selection: '',
    languageId: 'typescript',
    filePath: '/workspace/codex_autocomplete/src/fileB.ts',
    cursor: { line: 21, character: 3 },
    prefix: '',
    suffix: '',
    truncated: false,
  });

  assert.notEqual(first, second);
});
