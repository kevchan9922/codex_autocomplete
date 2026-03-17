const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  parseCsv,
  readOutputRowCount,
  evaluateRowCountParity,
} = require('../scripts/run-bulk-autocomplete-workflow.js');

test('parseCsv preserves multiline quoted cells as a single record', () => {
  const content = [
    'test,target_output,context,output',
    '"ROW-1","name);","{',
    '  ""prefix"": ""const message = welcome("",',
    '  ""suffix"": """"',
    '}","name);"',
    '"ROW-2","id","{}","id"',
  ].join('\n');

  const rows = parseCsv(content);
  assert.equal(rows.length, 3);
  assert.equal(rows[1][0], 'ROW-1');
  assert.match(rows[1][2], /"prefix": "const message = welcome\("/);
  assert.equal(rows[2][0], 'ROW-2');
});

test('readOutputRowCount counts CSV records instead of raw line count', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-autocomplete-workflow-'));
  const csvPath = path.join(tempDir, 'autocomplete_test_output_20260302_000000.csv');
  const content = [
    'test,target_output,context,output',
    '"ROW-1","name);","{',
    '  ""prefix"": ""const message = welcome("",',
    '  ""suffix"": """"',
    '}","name);"',
    '"ROW-2","id","{}","id"',
  ].join('\n');
  await fs.writeFile(csvPath, `${content}\n`, 'utf8');

  const recordCount = await readOutputRowCount(csvPath);
  assert.equal(recordCount, 2);
});

test('evaluateRowCountParity reports warning by default and failure when fail-on-row-mismatch is enabled', () => {
  const warningResult = evaluateRowCountParity(63, 62, false);
  assert.equal(warningResult.mismatch, true);
  assert.equal(warningResult.shouldFail, false);
  assert.match(warningResult.statusLine, /warning: row count mismatch/);

  const failResult = evaluateRowCountParity(63, 62, true);
  assert.equal(failResult.mismatch, true);
  assert.equal(failResult.shouldFail, true);
  assert.match(failResult.statusLine, /error: row count mismatch/);

  const okResult = evaluateRowCountParity(63, 63, true);
  assert.equal(okResult.mismatch, false);
  assert.equal(okResult.shouldFail, false);
  assert.match(okResult.statusLine, /parity check passed/);
});
