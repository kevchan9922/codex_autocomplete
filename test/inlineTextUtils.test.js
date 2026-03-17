require('./helpers/registerVscode.js');

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  keepLastRepeatedPrefixLineSegment,
  trimOverlapWithPrefix,
  trimTrailingOverlapWithSuffixStart,
  trimOverlapWithSuffixStart,
} = require('../out/completion/inlineTextUtils.js');

test('trimOverlapWithSuffixStart removes duplicated line prefix already in suffix', () => {
  const suggestion = 'message = greet_user("Mina")';
  const suffix = 'message = greet_user(\n\nif __name__ == "__main__":\n    demo()';

  const trimmed = trimOverlapWithSuffixStart(suggestion, suffix);
  assert.equal(trimmed, '"Mina")');
});

test('trimOverlapWithSuffixStart ignores tiny accidental overlap', () => {
  const suggestion = 'item';
  const suffix = 'if value:\n    pass';

  const trimmed = trimOverlapWithSuffixStart(suggestion, suffix);
  assert.equal(trimmed, suggestion);
});

test('prefix then suffix trimming yields only missing tail', () => {
  const rawSuggestion = 'message = greet_user("Mina")';
  const prefix = 'def demo():\n    profile = format_user(7, "Mina")\n    print(profile)\n';
  const suffix = 'message = greet_user(\n';

  const afterPrefix = trimOverlapWithPrefix(rawSuggestion, prefix);
  const final = trimOverlapWithSuffixStart(afterPrefix, suffix);
  assert.equal(final, '"Mina")');
});

test('repeated prefix salvage keeps last code segment and drops noisy prose', () => {
  const noisy = 'message = greet_user(" /> Let\'s fix: maybe message = greet_user("Mina")';
  const prefix = 'def demo():\n    message = greet_user(';
  const suffix = ')\n';

  const salvaged = keepLastRepeatedPrefixLineSegment(noisy, prefix);
  const afterPrefix = trimOverlapWithPrefix(salvaged, prefix);
  const final = trimTrailingOverlapWithSuffixStart(
    trimOverlapWithSuffixStart(afterPrefix, suffix),
    suffix,
  );
  assert.equal(final, '"Mina"');
});

test('trimOverlapWithPrefix keeps suffix suggestion when only one-char overlap exists', () => {
  const suggestion = 'per()';
  const prefix = 'def run():\n    return first.up';

  const trimmed = trimOverlapWithPrefix(suggestion, prefix);
  assert.equal(trimmed, suggestion);
});
