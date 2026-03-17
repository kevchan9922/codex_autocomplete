require('./helpers/registerVscode.js');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { runAutocompleteResponseTimeTest } = require('../out/debug/responseTimeRunner.js');

const RUN_OUTPUT_HEADER =
  'test,target_output,first_chunk_ms,total_duration_ms,status,match_target_output,context_char_count,instructions_char_count,input_chars_est,input_tokens_est,output,benchmark_mode,prefix_chars,suffix_chars,extra_context_chars,scenario_chars,constraint_chars,before_lines_count,headers_latency_ms,first_raw_chunk_ms,first_payload_ms,first_text_ms,stream_duration_ms,server_processing_ms,request_id,row_tags,pre_attempt_ms,hotkey_press_to_accept_ms';
const HISTORY_HEADER =
  'run_id,run_started_at,test,target_output,first_chunk_ms,total_duration_ms,status,match_target_output,output_length,language_id,file_path,model,endpoint,context_char_count,instructions_char_count,input_chars_est,input_tokens_est,benchmark_mode,prefix_chars,suffix_chars,extra_context_chars,scenario_chars,constraint_chars,before_lines_count,headers_latency_ms,first_raw_chunk_ms,first_payload_ms,first_text_ms,stream_duration_ms,server_processing_ms,request_id,row_tags,pre_attempt_ms,hotkey_press_to_accept_ms';

function parseCsvLine(line) {
  const cells = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      cells.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  cells.push(current);
  return cells;
}

test('runAutocompleteResponseTimeTest writes per-run output and history rows', async () => {
  const workspaceFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-autocomplete-rt-'));
  const inputDir = path.join(workspaceFolder, 'test_files');
  await fs.mkdir(inputDir, { recursive: true });
  await fs.writeFile(
    path.join(inputDir, 'autocomplete_test_input.json'),
    JSON.stringify([
      {
        test: 'PY-1 | simple call',
        target_output: '"Mina")',
        file_path: 'test_files/typescript/simple_autocomplete.ts',
        language_id: 'typescript',
      },
      { test: 'PY-2 | empty case', target_output: 'n/a' },
    ], null, 2),
    'utf8',
  );

  const logs = [];
  const output = {
    appendLine(line) {
      logs.push(line);
    },
  };

  const seenRequests = [];
  let requestCount = 0;
  const provider = {
    async *streamCompletion(request) {
      seenRequests.push(request);
      request.onTelemetry?.({
        preAttemptMs: 2,
        headersLatencyMs: 12,
        firstRawChunkMs: 3,
        firstPayloadMs: 4,
        firstTextMs: 9,
        streamDurationMs: 21,
        serverProcessingMs: 8,
        requestId: `req-${requestCount + 1}`,
      });
      if (requestCount === 0) {
        yield { text: '"Mina")', done: false };
      }
      requestCount += 1;
      yield { text: '', done: true };
    },
  };

  await runAutocompleteResponseTimeTest({
    workspaceFolder,
    output,
    provider,
    languageId: 'python',
    filePath: '/workspace/manual_test.py',
    model: 'gpt-5.4',
    endpoint: 'https://chatgpt.com/backend-api/codex/responses',
    instructions: 'Return only code',
    maxOutputTokens: 64,
    serviceTier: 'priority',
    promptCacheKey: 'response-time-test',
    promptCacheRetention: '24h',
    benchmarkMode: 'automatic_direct',
    buildContext: () => '{"prefix":"x","suffix":"y"}',
    timestamp: new Date(2026, 1, 28, 15, 0, 0),
  });

  const artifactDir = path.join(workspaceFolder, 'test_artifacts');
  const files = await fs.readdir(artifactDir);
  const runOutputFile = files.find((file) => /^response_time_test_output_\d{8}_\d{6}\.csv$/.test(file));
  assert.ok(runOutputFile, 'expected response-time run output CSV');

  const runCsv = await fs.readFile(path.join(artifactDir, runOutputFile), 'utf8');
  assert.ok(runCsv.startsWith(`${RUN_OUTPUT_HEADER}\n`));
  assert.match(runCsv, /PY-1 \| simple call/);
  assert.match(runCsv, /PY-2 \| empty case/);
  assert.match(runCsv, /success/);
  assert.match(runCsv, /empty/);
  const runLines = runCsv.trimEnd().split('\n');
  const emptyRow = parseCsvLine(runLines[2]);
  assert.equal(emptyRow[0], 'PY-2 | empty case');
  assert.equal(emptyRow[2], 'n/a');
  assert.equal(emptyRow[11], 'automatic_direct');
  const firstRunRow = parseCsvLine(runLines[1]);
  assert.equal(firstRunRow[12], '1');
  assert.equal(firstRunRow[13], '1');
  assert.equal(firstRunRow[14], '0');
  assert.equal(firstRunRow[15], '0');
  assert.match(firstRunRow[16], /^\d+$/);
  assert.equal(firstRunRow[17], '0');
  assert.equal(firstRunRow[18], '12');
  assert.equal(firstRunRow[19], '3');
  assert.equal(firstRunRow[20], '4');
  assert.equal(firstRunRow[21], '9');
  assert.equal(firstRunRow[22], '21');
  assert.equal(firstRunRow[23], '8');
  assert.equal(firstRunRow[24], 'req-1');
  assert.equal(firstRunRow[25], 'lang:typescript');
  assert.equal(firstRunRow[26], '2');
  assert.equal(firstRunRow[27], 'n/a');

  const historyCsv = await fs.readFile(path.join(artifactDir, 'response_time_history.csv'), 'utf8');
  const historyLines = historyCsv.trimEnd().split('\n');
  assert.equal(historyLines[0], HISTORY_HEADER);
  assert.equal(historyLines.length, 3);
  const historyFirstRow = parseCsvLine(historyLines[1]);
  const historyEmptyRow = parseCsvLine(historyLines[2]);
  assert.equal(historyFirstRow[9], 'typescript');
  assert.equal(
    historyFirstRow[10],
    path.join(workspaceFolder, 'test_files', 'typescript', 'simple_autocomplete.ts'),
  );
  assert.equal(historyEmptyRow[2], 'PY-2 | empty case');
  assert.equal(historyEmptyRow[4], 'n/a');
  assert.equal(historyFirstRow[13], '0');
  assert.match(historyFirstRow[14], /^\d+$/);
  assert.match(historyFirstRow[15], /^\d+$/);
  assert.match(historyFirstRow[16], /^\d+$/);
  assert.equal(historyFirstRow[17], 'automatic_direct');
  assert.equal(historyFirstRow[18], '1');
  assert.equal(historyFirstRow[19], '1');
  assert.equal(historyFirstRow[20], '0');
  assert.equal(historyFirstRow[21], '0');
  assert.match(historyFirstRow[22], /^\d+$/);
  assert.equal(historyFirstRow[23], '0');
  assert.equal(historyFirstRow[24], '12');
  assert.equal(historyFirstRow[25], '3');
  assert.equal(historyFirstRow[26], '4');
  assert.equal(historyFirstRow[27], '9');
  assert.equal(historyFirstRow[28], '21');
  assert.equal(historyFirstRow[29], '8');
  assert.equal(historyFirstRow[30], 'req-1');
  assert.equal(historyFirstRow[31], 'lang:typescript');
  assert.equal(historyFirstRow[32], '2');
  assert.equal(historyFirstRow[33], 'n/a');
  assert.match(historyCsv, /gpt-5.4/);
  assert.match(historyCsv, /https:\/\/chatgpt\.com\/backend-api\/codex\/responses/);

  assert.equal(seenRequests.length, 2);
  assert.equal(seenRequests[0].interactionMode, 'automatic');
  assert.equal(seenRequests[0].languageId, 'typescript');
  assert.equal(
    seenRequests[0].filePath,
    path.join(workspaceFolder, 'test_files', 'typescript', 'simple_autocomplete.ts'),
  );
  assert.equal(seenRequests[0].prefix, 'x');
  assert.equal(seenRequests[0].suffix, 'y');
  assert.equal(seenRequests[0].context, undefined);
  assert.equal(seenRequests[1].interactionMode, 'automatic');
  assert.equal(seenRequests[1].languageId, 'python');
  assert.equal(seenRequests[1].filePath, '/workspace/manual_test.py');
  assert.equal(seenRequests[1].prefix, 'x');
  assert.equal(seenRequests[1].suffix, 'y');
  assert.equal(seenRequests[1].context, undefined);

  assert.ok(logs.some((line) => line.includes('Response-time row 1/2')));
  assert.ok(logs.some((line) => line.includes('Response-time history:')));
  assert.ok(logs.some((line) => line.includes('input_chars_est=')));
  assert.ok(logs.some((line) => line.includes('headers_ms=12')));
  assert.ok(logs.some((line) => line.includes('pre_attempt_ms=2')));
  assert.ok(logs.some((line) => line.includes('scenario_chars=0')));
  assert.ok(logs.some((line) => line.includes('row_tags=lang:typescript')));
});

test.skip('runAutocompleteResponseTimeTest supports staged hotkey_inline benchmark mode with full fallback', async () => {
  const workspaceFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-autocomplete-rt-'));
  const inputDir = path.join(workspaceFolder, 'test_files');
  await fs.mkdir(inputDir, { recursive: true });
  await fs.writeFile(
    path.join(inputDir, 'autocomplete_test_input.json'),
    JSON.stringify([
      {
        test: 'PY-HOTKEY | fallback',
        target_output: 'name)',
      },
    ], null, 2),
    'utf8',
  );

  const seenRequests = [];
  const provider = {
    async *streamCompletion(request) {
      seenRequests.push(request);
      if (String(request.promptCacheKey).endsWith(':full')) {
        yield { text: 'name)', done: false };
      }
      yield { text: '', done: true };
    },
  };

  const logs = [];
  await runAutocompleteResponseTimeTest({
    workspaceFolder,
    output: { appendLine(line) { logs.push(line); } },
    provider,
    languageId: 'python',
    filePath: '/workspace/manual_test.py',
    model: 'gpt-5.4',
    endpoint: 'https://chatgpt.com/backend-api/codex/responses',
    instructions: 'Return only code',
    promptCacheKey: 'rt-hotkey',
    benchmarkMode: 'hotkey_inline',
    hotkeySemanticRetryEnabled: false,
    buildContext: () =>
      '{"prefix":"from os import path\\nvalue = greet(","suffix":")","context":"LOCAL_CONTEXT"}',
    timestamp: new Date(2026, 1, 28, 15, 30, 0),
  });

  const artifactDir = path.join(workspaceFolder, 'test_artifacts');
  const files = await fs.readdir(artifactDir);
  const runOutputFile = files.find((file) => /^response_time_test_output_\d{8}_\d{6}\.csv$/.test(file));
  assert.ok(runOutputFile, 'expected response-time run output CSV');

  const runCsv = await fs.readFile(path.join(artifactDir, runOutputFile), 'utf8');
  const runLines = runCsv.trimEnd().split('\n');
  const runRow = parseCsvLine(runLines[1]);
  assert.equal(runRow[11], 'hotkey_inline');
  assert.match(runRow[27], /^\d+$/);

  const historyCsv = await fs.readFile(path.join(artifactDir, 'response_time_history.csv'), 'utf8');
  const historyLines = historyCsv.trimEnd().split('\n');
  const historyRow = parseCsvLine(historyLines[1]);
  assert.equal(historyRow[17], 'hotkey_inline');
  assert.equal(historyRow[13], String('LOCAL_CONTEXT'.length));
  assert.match(historyRow[33], /^\d+$/);

  assert.equal(seenRequests.length, 2);
  assert.ok(seenRequests.every((request) => request.interactionMode === 'hotkey'));
  assert.equal(seenRequests[0].promptCacheKey, 'rt-hotkey:fast');
  assert.equal(seenRequests[1].promptCacheKey, 'rt-hotkey:full');
  assert.equal(seenRequests[0].context, undefined);
  assert.equal(seenRequests[1].context, 'LOCAL_CONTEXT');
  assert.match(seenRequests[0].instructions ?? '', /Target constraints:/);
  assert.ok(logs.some((line) => line.includes('hotkey_accept_ms=')));
});

test('runAutocompleteResponseTimeTest normalizes automatic_direct outputs before scoring', async () => {
  const workspaceFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-autocomplete-rt-'));
  const inputDir = path.join(workspaceFolder, 'test_files');
  await fs.mkdir(inputDir, { recursive: true });
  await fs.writeFile(
    path.join(inputDir, 'autocomplete_test_input.json'),
    JSON.stringify([
      {
        test: 'TS-DIRECT-NORMALIZE',
        target_output: 'UpperCase();',
        file_path: 'test_files/typescript/patterns_autocomplete.ts',
        language_id: 'typescript',
      },
    ], null, 2),
    'utf8',
  );

  const seenRequests = [];
  const provider = {
    async *streamCompletion(request) {
      seenRequests.push(request);
      yield { text: 'UpperCase()', done: false };
      yield { text: '', done: true };
    },
  };

  await runAutocompleteResponseTimeTest({
    workspaceFolder,
    output: { appendLine() {} },
    provider,
    languageId: 'typescript',
    filePath: '/workspace/manual_test.ts',
    model: 'gpt-5.4',
    endpoint: 'https://api.openai.com/v1/responses',
    instructions: 'Return only code',
    benchmarkMode: 'automatic_direct',
    buildContext: () =>
      '{"prefix":"const upper = person.name.to","suffix":"","context":"SHOULD_NOT_BE_SENT","beforeLines":["const upper = person.name.to"]}',
    timestamp: new Date(2026, 1, 28, 15, 35, 0),
  });

  assert.equal(seenRequests.length, 1);
  assert.equal(seenRequests[0].interactionMode, 'automatic');
  assert.equal(seenRequests[0].context, undefined);
  assert.doesNotMatch(seenRequests[0].instructions ?? '', /Response-time scenario:/);
  assert.doesNotMatch(seenRequests[0].instructions ?? '', /TS-DIRECT-NORMALIZE/);

  const artifactDir = path.join(workspaceFolder, 'test_artifacts');
  const files = await fs.readdir(artifactDir);
  const runOutputFile = files.find((file) => /^response_time_test_output_\d{8}_\d{6}\.csv$/.test(file));
  assert.ok(runOutputFile, 'expected response-time run output CSV');
  const runCsv = await fs.readFile(path.join(artifactDir, runOutputFile), 'utf8');
  const runLines = runCsv.trimEnd().split('\n');
  const runRow = parseCsvLine(runLines[1]);
  assert.equal(runRow[0], 'TS-DIRECT-NORMALIZE');
  assert.equal(runRow[4], 'success');
  assert.equal(runRow[5], 'true');
  assert.equal(runRow[10], 'UpperCase();');
  assert.equal(runRow[11], 'automatic_direct');
});

test('runAutocompleteResponseTimeTest leaves scenario-dependent rows unscored for exact match', async () => {
  const workspaceFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-autocomplete-rt-'));
  const inputDir = path.join(workspaceFolder, 'test_files');
  await fs.mkdir(inputDir, { recursive: true });
  await fs.writeFile(
    path.join(inputDir, 'autocomplete_test_input.json'),
    JSON.stringify([
      {
        test: 'Boundary-1 Python large file',
        target_output: '<scenario-dependent>',
        file_path: 'test_files/python/patterns_autocomplete.py',
        language_id: 'python',
      },
    ], null, 2),
    'utf8',
  );

  const logs = [];
  const provider = {
    async *streamCompletion() {
      yield { text: ')[0]', done: false };
      yield { text: '', done: true };
    },
  };

  await runAutocompleteResponseTimeTest({
    workspaceFolder,
    output: {
      appendLine(line) {
        logs.push(line);
      },
    },
    provider,
    languageId: 'python',
    filePath: '/workspace/manual_test.py',
    model: 'gpt-5.4',
    endpoint: 'https://chatgpt.com/backend-api/codex/responses',
    instructions: 'Return only code',
    benchmarkMode: 'automatic_direct',
    buildContext: () => '{"prefix":"return lines.split(","suffix":"","context":""}',
    timestamp: new Date(2026, 1, 28, 15, 40, 0),
  });

  const artifactDir = path.join(workspaceFolder, 'test_artifacts');
  const files = await fs.readdir(artifactDir);
  const runOutputFile = files.find((file) => /^response_time_test_output_\d{8}_\d{6}\.csv$/.test(file));
  assert.ok(runOutputFile, 'expected response-time run output CSV');

  const runCsv = await fs.readFile(path.join(artifactDir, runOutputFile), 'utf8');
  const runRow = parseCsvLine(runCsv.trimEnd().split('\n')[1]);
  assert.equal(runRow[0], 'Boundary-1 Python large file');
  assert.equal(runRow[5], '');
  assert.equal(runRow[10], ')[0]');
  assert.match(runRow[25], /scenario_dependent/);
  assert.match(runRow[25], /large_file/);

  const historyCsv = await fs.readFile(path.join(artifactDir, 'response_time_history.csv'), 'utf8');
  const historyRow = parseCsvLine(historyCsv.trimEnd().split('\n')[1]);
  assert.equal(historyRow[2], 'Boundary-1 Python large file');
  assert.equal(historyRow[7], '');
  assert.match(historyRow[31], /scenario_dependent/);

  assert.ok(logs.some((line) => line.includes('match=n/a')));
});

test.skip('runAutocompleteResponseTimeTest adds target-derived constraints to request instructions', async () => {
  const workspaceFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-autocomplete-rt-'));
  const inputDir = path.join(workspaceFolder, 'test_files');
  await fs.mkdir(inputDir, { recursive: true });
  await fs.writeFile(
    path.join(inputDir, 'autocomplete_test_input.json'),
    JSON.stringify([
      {
        test: 'PY-LOCKS | mixed args',
        target_output: '25, order_by="created_at")',
        file_path: 'test_files/python/advanced_autocomplete.py',
        language_id: 'python',
        lock_quotes: true,
        lock_arg_form: true,
      },
    ], null, 2),
    'utf8',
  );

  const seenRequests = [];
  const provider = {
    async *streamCompletion(request) {
      seenRequests.push(request);
      yield { text: '25, order_by="created_at")', done: false };
      yield { text: '', done: true };
    },
  };

  await runAutocompleteResponseTimeTest({
    workspaceFolder,
    output: { appendLine() {} },
    provider,
    languageId: 'python',
    filePath: '/workspace/manual_test.py',
    model: 'gpt-5.4',
    endpoint: 'https://chatgpt.com/backend-api/codex/responses',
    instructions: 'Return only code',
    benchmarkMode: 'automatic_direct',
    buildContext: () =>
      '{"prefix":"query = build_query(\\"users\\", filters, ","suffix":"","context":""}',
    timestamp: new Date(2026, 1, 28, 15, 45, 0),
  });

  assert.equal(seenRequests.length, 1);
  assert.match(seenRequests[0].instructions ?? '', /Target constraints:/);
  assert.ok(
    (seenRequests[0].instructions ?? '').includes('TARGET_EXACT_SUFFIX: "25, order_by=\\"created_at\\")"'),
  );
  assert.match(seenRequests[0].instructions ?? '', /TARGET_NAMED_ARGS: order_by/);
  assert.match(
    seenRequests[0].instructions ?? '',
    /TARGET_NAMED_ARG_BINDINGS: order_by="created_at"/,
  );
  assert.match(
    seenRequests[0].instructions ?? '',
    /TARGET_NAMED_ARG_VALUE_LOCK: preserve label=value pairs/,
  );
  assert.match(seenRequests[0].instructions ?? '', /TARGET_ARG_SEQUENCE: 25 \| order_by="created_at"/);
  assert.match(
    seenRequests[0].instructions ?? '',
    /TARGET_ARG_SEQUENCE_LOCK: preserve order and values/,
  );
  assert.match(seenRequests[0].instructions ?? '', /TARGET_STRINGS: "created_at"/);
  assert.match(seenRequests[0].instructions ?? '', /TARGET_STRING_LOCK: exact/);
  assert.match(
    seenRequests[0].instructions ?? '',
    /(TARGET_STRING_LOCK: exact|TARGET_STRING_RULE: verbatim; no alias swaps)/,
  );
  assert.match(seenRequests[0].instructions ?? '', /(TARGET_NUMS: 25|TARGET_ARG_SEQUENCE: 25 \| order_by="created_at")/);
});

test('runAutocompleteResponseTimeTest appends history across runs without duplicate header', async () => {
  const workspaceFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-autocomplete-rt-'));
  const inputDir = path.join(workspaceFolder, 'test_files');
  await fs.mkdir(inputDir, { recursive: true });
  await fs.writeFile(
    path.join(inputDir, 'autocomplete_test_input.json'),
    JSON.stringify([{ test: 'PY-1 | simple call', target_output: '"Mina")' }], null, 2),
    'utf8',
  );

  const output = { appendLine() {} };
  const provider = {
    async *streamCompletion() {
      yield { text: '"Mina")', done: false };
      yield { text: '', done: true };
    },
  };

  await runAutocompleteResponseTimeTest({
    workspaceFolder,
    output,
    provider,
    languageId: 'python',
    filePath: '/workspace/manual_test.py',
    model: 'gpt-5.4',
    endpoint: 'https://chatgpt.com/backend-api/codex/responses',
    instructions: 'Return only code',
    buildContext: () => '{}',
    timestamp: new Date(2026, 1, 28, 16, 0, 0),
  });

  await runAutocompleteResponseTimeTest({
    workspaceFolder,
    output,
    provider,
    languageId: 'python',
    filePath: '/workspace/manual_test.py',
    model: 'gpt-5.4',
    endpoint: 'https://chatgpt.com/backend-api/codex/responses',
    instructions: 'Return only code',
    buildContext: () => '{}',
    timestamp: new Date(2026, 1, 28, 17, 0, 0),
  });

  const historyCsv = await fs.readFile(path.join(workspaceFolder, 'test_artifacts', 'response_time_history.csv'), 'utf8');
  const headerLine = HISTORY_HEADER;
  const lines = historyCsv.trimEnd().split('\n');
  const headerCount = lines.filter((line) => line === headerLine).length;

  assert.equal(headerCount, 1);
  assert.equal(lines.length, 3);
  assert.match(historyCsv, /20260228_160000/);
  assert.match(historyCsv, /20260228_170000/);
});

test('runAutocompleteResponseTimeTest supports custom input file path', async () => {
  const workspaceFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-autocomplete-rt-'));
  const inputDir = path.join(workspaceFolder, 'test_files');
  await fs.mkdir(inputDir, { recursive: true });
  const customInputPath = path.join(inputDir, 'response_time_test_input.json');
  await fs.writeFile(
    customInputPath,
    JSON.stringify([{ test: 'PY-CUSTOM', target_output: 'name)' }], null, 2),
    'utf8',
  );

  const provider = {
    async *streamCompletion() {
      yield { text: 'name)', done: false };
      yield { text: '', done: true };
    },
  };

  await runAutocompleteResponseTimeTest({
    workspaceFolder,
    output: { appendLine() {} },
    provider,
    languageId: 'python',
    filePath: '/workspace/manual_test.py',
    model: 'gpt-5.4',
    endpoint: 'https://chatgpt.com/backend-api/codex/responses',
    instructions: 'Return only code',
    inputFilePath: customInputPath,
    buildContext: () => '{}',
    timestamp: new Date(2026, 1, 28, 18, 0, 0),
  });

  const historyCsv = await fs.readFile(path.join(workspaceFolder, 'test_artifacts', 'response_time_history.csv'), 'utf8');
  assert.match(historyCsv, /PY-CUSTOM/);
});

test('runAutocompleteResponseTimeTest migrates legacy history header and preserves existing rows', async () => {
  const workspaceFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-autocomplete-rt-'));
  const inputDir = path.join(workspaceFolder, 'test_files');
  await fs.mkdir(inputDir, { recursive: true });
  await fs.writeFile(
    path.join(inputDir, 'autocomplete_test_input.json'),
    JSON.stringify([{ test: 'PY-NEW', target_output: 'name)' }], null, 2),
    'utf8',
  );

  const legacyHeader = 'run_id,run_started_at,test,target_output,first_chunk_ms,total_duration_ms,status,match_target_output,output_length,language_id,file_path,model,endpoint';
  const legacyRow = '20260228_120000,2026-02-28T20:00:00.000Z,PY-OLD,name),101,140,success,true,5,python,/tmp/old.py,gpt-5.4,https://chatgpt.com/backend-api/codex/responses';
  await fs.writeFile(
    path.join(workspaceFolder, 'response_time_history.csv'),
    `${legacyHeader}\n${legacyRow}\n`,
    'utf8',
  );

  const provider = {
    async *streamCompletion() {
      yield { text: 'name)', done: false };
      yield { text: '', done: true };
    },
  };

  await runAutocompleteResponseTimeTest({
    workspaceFolder,
    output: { appendLine() {} },
    provider,
    languageId: 'python',
    filePath: '/workspace/manual_test.py',
    model: 'gpt-5.4',
    endpoint: 'https://chatgpt.com/backend-api/codex/responses',
    instructions: 'Return only code',
    benchmarkMode: 'automatic_direct',
    buildContext: () => '{"prefix":"x","suffix":"y"}',
    timestamp: new Date(2026, 1, 28, 19, 0, 0),
  });

  const historyCsv = await fs.readFile(path.join(workspaceFolder, 'test_artifacts', 'response_time_history.csv'), 'utf8');
  const lines = historyCsv.trimEnd().split('\n');
  assert.equal(
    lines[0],
    HISTORY_HEADER,
  );
  assert.equal(lines.length, 3);

  const migratedLegacyRow = parseCsvLine(lines[1]);
  assert.equal(migratedLegacyRow[2], 'PY-OLD');
  assert.equal(migratedLegacyRow[13], '');
  assert.equal(migratedLegacyRow[14], '');
  assert.equal(migratedLegacyRow[15], '');
  assert.equal(migratedLegacyRow[16], '');
  assert.equal(migratedLegacyRow[17], '');
  assert.equal(migratedLegacyRow[18], '');
  assert.equal(migratedLegacyRow[30], '');
  assert.equal(migratedLegacyRow[31], '');
  assert.equal(migratedLegacyRow[32], '');

  const newRow = parseCsvLine(lines[2]);
  assert.equal(newRow[2], 'PY-NEW');
  assert.equal(newRow[13], '0');
  assert.match(newRow[14], /^\d+$/);
  assert.match(newRow[15], /^\d+$/);
  assert.match(newRow[16], /^\d+$/);
  assert.equal(newRow[17], 'automatic_direct');
});

test('runAutocompleteResponseTimeTest migrates v1 history header by appending benchmark mode column', async () => {
  const workspaceFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-autocomplete-rt-'));
  const inputDir = path.join(workspaceFolder, 'test_files');
  const artifactDir = path.join(workspaceFolder, 'test_artifacts');
  await fs.mkdir(inputDir, { recursive: true });
  await fs.mkdir(artifactDir, { recursive: true });
  await fs.writeFile(
    path.join(inputDir, 'autocomplete_test_input.json'),
    JSON.stringify([{ test: 'PY-V1', target_output: 'name)' }], null, 2),
    'utf8',
  );

  const v1Header =
    'run_id,run_started_at,test,target_output,first_chunk_ms,total_duration_ms,status,match_target_output,output_length,language_id,file_path,model,endpoint,context_char_count,instructions_char_count,input_chars_est,input_tokens_est';
  const v1Row =
    '20260228_090000,2026-02-28T09:00:00.000Z,PY-OLD,name),101,140,success,true,5,python,/tmp/old.py,gpt-5.4,https://chatgpt.com/backend-api/codex/responses,0,250,900,225';
  await fs.writeFile(
    path.join(artifactDir, 'response_time_history.csv'),
    `${v1Header}\n${v1Row}\n`,
    'utf8',
  );

  const provider = {
    async *streamCompletion() {
      yield { text: 'name)', done: false };
      yield { text: '', done: true };
    },
  };

  await runAutocompleteResponseTimeTest({
    workspaceFolder,
    output: { appendLine() {} },
    provider,
    languageId: 'python',
    filePath: '/workspace/manual_test.py',
    model: 'gpt-5.4',
    endpoint: 'https://chatgpt.com/backend-api/codex/responses',
    instructions: 'Return only code',
    benchmarkMode: 'automatic_direct',
    buildContext: () => '{"prefix":"x","suffix":"y"}',
    timestamp: new Date(2026, 1, 28, 20, 0, 0),
  });

  const historyCsv = await fs.readFile(path.join(artifactDir, 'response_time_history.csv'), 'utf8');
  const lines = historyCsv.trimEnd().split('\n');
  const migratedLegacyRow = parseCsvLine(lines[1]);
  const newRow = parseCsvLine(lines[2]);
  assert.equal(migratedLegacyRow[2], 'PY-OLD');
  assert.equal(migratedLegacyRow[17], '');
  assert.equal(migratedLegacyRow[18], '');
  assert.equal(migratedLegacyRow[30], '');
  assert.equal(migratedLegacyRow[31], '');
  assert.equal(migratedLegacyRow[32], '');
  assert.equal(newRow[2], 'PY-V1');
  assert.equal(newRow[17], 'automatic_direct');
});
