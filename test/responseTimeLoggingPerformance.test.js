require('./helpers/registerVscode.js');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { runAutocompleteResponseTimeTest } = require('../out/debug/responseTimeRunner.js');
const { getCodexLogLevel, setCodexLogLevel } = require('../out/logging/codexLogger.js');

function parseCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  result.push(current);
  return result;
}

function average(values) {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

async function runLevelBenchmark(workspaceFolder, level, timestamp) {
  const outputLines = [];
  const output = {
    appendLine(line) {
      outputLines.push(line);
    },
  };

  const provider = {
    async *streamCompletion() {
      yield { text: 'name);', done: false };
      yield { text: '', done: true };
    },
  };

  await runAutocompleteResponseTimeTest({
    workspaceFolder,
    output,
    provider,
    languageId: 'typescript',
    filePath: path.join(workspaceFolder, 'test_files', 'typescript', 'simple_autocomplete.ts'),
    model: 'gpt-5.4',
    endpoint: 'https://chatgpt.com/backend-api/codex/responses',
    instructions: 'Return only code',
    benchmarkMode: 'hotkey_inline',
    hotkeySemanticRetryEnabled: false,
    buildContext: () => ({
      prefix: 'return greet(',
      suffix: '',
      linePrefix: 'return greet(',
      lineSuffix: '',
      beforeLines: ['return greet('],
      hash: 'ctx-hash',
    }),
    buildContextForRow: () => ({
      prefix: 'return greet(',
      suffix: '',
      linePrefix: 'return greet(',
      lineSuffix: '',
      beforeLines: ['return greet('],
      hash: 'ctx-hash',
    }),
    timestamp,
  });

  const historyPath = path.join(workspaceFolder, 'test_artifacts', 'response_time_history.csv');
  const historyCsv = await fs.readFile(historyPath, 'utf8');
  const rows = historyCsv.trimEnd().split('\n').slice(1).map(parseCsvLine);
  const runId = `${timestamp.getFullYear()}${String(timestamp.getMonth() + 1).padStart(2, '0')}${String(timestamp.getDate()).padStart(2, '0')}_${String(timestamp.getHours()).padStart(2, '0')}${String(timestamp.getMinutes()).padStart(2, '0')}${String(timestamp.getSeconds()).padStart(2, '0')}`;
  const runRows = rows.filter((row) => row[0] === runId);
  const totalDurations = runRows
    .map((row) => Number.parseInt(row[5] ?? '0', 10))
    .filter((value) => Number.isFinite(value) && value > 0);

  const rowLines = outputLines.filter((line) => line.startsWith('Row '));

  return {
    level,
    avgTotalDurationMs: average(totalDurations),
    rowLines,
  };
}

test('response-time hotkey benchmark compares off/info/debug logging impact', async () => {
  const previousLevel = getCodexLogLevel();
  const workspaceFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-autocomplete-rt-logging-'));
  const inputDir = path.join(workspaceFolder, 'test_files');
  await fs.mkdir(inputDir, { recursive: true });

  const rows = Array.from({ length: 60 }, (_, index) => ({
    test: `RT-LOG-${index + 1}`,
    target_output: 'name);',
    file_path: 'test_files/typescript/simple_autocomplete.ts',
    language_id: 'typescript',
    cursor_after: 'return greet(',
  }));
  await fs.writeFile(path.join(inputDir, 'autocomplete_test_input.json'), JSON.stringify(rows), 'utf8');

  try {
    setCodexLogLevel('off');
    const offResult = await runLevelBenchmark(
      workspaceFolder,
      'off',
      new Date(2026, 1, 28, 18, 0, 0),
    );

    setCodexLogLevel('info');
    const infoResult = await runLevelBenchmark(
      workspaceFolder,
      'info',
      new Date(2026, 1, 28, 18, 5, 0),
    );

    setCodexLogLevel('debug');
    const debugResult = await runLevelBenchmark(
      workspaceFolder,
      'debug',
      new Date(2026, 1, 28, 18, 10, 0),
    );

    assert.ok(offResult.avgTotalDurationMs > 0);
    assert.ok(infoResult.avgTotalDurationMs > 0);
    assert.ok(debugResult.avgTotalDurationMs > 0);

    const offLine = offResult.rowLines[0] ?? '';
    const infoLine = infoResult.rowLines[0] ?? '';
    const debugLine = debugResult.rowLines[0] ?? '';

    assert.match(offLine, /info_log_emitted=0/);
    assert.match(offLine, /debug_log_emitted=0/);
    assert.match(infoLine, /info_log_emitted=\d+/);
    assert.match(infoLine, /debug_log_suppressed=\d+/);
    assert.match(debugLine, /info_log_emitted=\d+/);
    assert.match(debugLine, /debug_log_emitted=\d+/);

    // Non-strict comparison: debug/info should not be dramatically faster than off in aggregate.
    assert.ok(debugResult.avgTotalDurationMs >= offResult.avgTotalDurationMs * 0.5);
    assert.ok(infoResult.avgTotalDurationMs >= offResult.avgTotalDurationMs * 0.5);
  } finally {
    setCodexLogLevel(previousLevel);
    await fs.rm(workspaceFolder, { recursive: true, force: true });
  }
});
