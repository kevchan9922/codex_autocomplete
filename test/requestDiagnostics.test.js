const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeInlineRequestContext,
} = require('../out/completion/requestDiagnostics.js');

test('normalizeInlineRequestContext ignores non-JSON string context payloads', () => {
  const normalized = normalizeInlineRequestContext('this is not json');
  assert.equal(normalized.prefix, '');
  assert.equal(normalized.suffix, '');
  assert.equal(normalized.context, undefined);
});

test('normalizeInlineRequestContext parses JSON context payloads', () => {
  const normalized = normalizeInlineRequestContext(JSON.stringify({
    prefix: 'abc',
    suffix: 'def',
    context: 'extra',
  }));
  assert.equal(normalized.prefix, 'abc');
  assert.equal(normalized.suffix, 'def');
  assert.equal(normalized.context, 'extra');
});
