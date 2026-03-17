require('./helpers/registerVscode.js');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { runAutocompleteBulkTest } = require('../out/debug/bulkTestRunner.js');

test('runAutocompleteBulkTest writes output rows from explicit JSON target_output values', async () => {
  const workspaceFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-autocomplete-bulk-'));
  const inputDir = path.join(workspaceFolder, 'test_files');
  await fs.mkdir(inputDir, { recursive: true });
  await fs.writeFile(
    path.join(inputDir, 'autocomplete_test_input.json'),
    JSON.stringify([
      {
        test: 'PY-1 | simple call',
        target_output: '"Mina")',
        file_path: 'test_files/python/simple_autocomplete.py',
        language_id: 'python',
        cursor_after: 'message = greet_user(',
        lock_quotes: true,
        lock_arg_form: true,
      },
      {
        test: 'UNKNOWN-1 | custom case',
        target_output: 'custom-output',
        file_path: 'test_files/typescript/simple_autocomplete.ts',
        language_id: 'typescript',
        cursor_after: 'const message = welcome(',
      },
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
  const provider = {
    async *streamCompletion(request) {
      seenRequests.push({
        filePath: request.filePath,
        languageId: request.languageId,
        context: request.context,
        instructions: request.instructions,
      });
      if (request.instructions.includes('PY-1')) {
        yield { text: '"Mina")', done: false };
      } else {
        yield { text: 'custom-output', done: false };
      }
      yield { text: '', done: true };
    },
  };

  await runAutocompleteBulkTest({
    workspaceFolder,
    output,
    provider,
    languageId: 'python',
    filePath: '/workspace/manual_test.py',
    instructions: 'Return only code',
    maxOutputTokens: 64,
    serviceTier: 'priority',
    promptCacheKey: 'bulk-test',
    promptCacheRetention: '24h',
    buildContext: () => '{"prefix":"default","suffix":"default"}',
    buildContextForRow: (row) => JSON.stringify({
      filePath: row.filePath,
      languageId: row.languageId,
      cursorAfter: row.cursorAfter,
    }),
    timestamp: new Date(2026, 1, 28, 14, 0, 0),
  });

  const artifactDir = path.join(workspaceFolder, 'test_artifacts');
  const files = await fs.readdir(artifactDir);
  const outputFile = files.find((file) => /^autocomplete_test_output_\d{8}_\d{6}\.csv$/.test(file));
  assert.ok(outputFile, 'expected output CSV file to be created');

  const csv = await fs.readFile(path.join(artifactDir, outputFile), 'utf8');
  const lines = csv.trimEnd().split('\n');
  assert.equal(lines[0], 'test,target_output,context,output');
  assert.equal(lines.length, 3);
  assert.match(csv, /PY-1 \| simple call/);
  assert.match(csv, /""Mina""\)/);
  assert.match(csv, /UNKNOWN-1 \| custom case/);
  assert.match(csv, /custom-output/);
  assert.match(csv, /test_files\/python\/simple_autocomplete\.py/);
  assert.match(csv, /test_files\/typescript\/simple_autocomplete\.ts/);

  assert.equal(seenRequests.length, 2);
  assert.equal(
    seenRequests[0].filePath,
    path.join(workspaceFolder, 'test_files', 'python', 'simple_autocomplete.py'),
  );
  assert.equal(seenRequests[0].languageId, 'python');
  assert.equal(
    seenRequests[1].filePath,
    path.join(workspaceFolder, 'test_files', 'typescript', 'simple_autocomplete.ts'),
  );
  assert.equal(seenRequests[1].languageId, 'typescript');
  assert.match(
    seenRequests[0].instructions ?? '',
    /Bulk test completion constraints:/,
  );
  assert.match(
    seenRequests[0].instructions ?? '',
    /LOCK_QUOTES: enabled/,
  );
  assert.match(
    seenRequests[0].instructions ?? '',
    /LOCK_ARG_FORM: enabled/,
  );
  assert.match(
    seenRequests[0].instructions ?? '',
    /REQUIRED_STRING_LITERAL_LOCK: enabled/,
  );
  assert.match(
    seenRequests[0].instructions ?? '',
    /Bulk test scenario:\n\s*PY-1 \| simple call/,
  );

  assert.ok(logs.some((line) => line.includes('Processing row 1/2')));
  assert.ok(logs.some((line) => line.includes('Processing row 2/2')));
  assert.ok(logs.some((line) => line.includes('first_chunk_ms=')));
  assert.ok(logs.some((line) => line.includes('total_duration_ms=')));
  assert.ok(logs.some((line) => line.includes('Timing summary | avg_first_chunk_ms=')));
  assert.ok(logs.some((line) => line.includes('Wrote 2 rows to')));
});

test('runAutocompleteBulkTest supports staged hotkey_inline benchmark mode', async () => {
  const workspaceFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-autocomplete-bulk-'));
  const inputDir = path.join(workspaceFolder, 'test_files');
  await fs.mkdir(inputDir, { recursive: true });
  await fs.writeFile(
    path.join(inputDir, 'autocomplete_test_input.json'),
    JSON.stringify([
      {
        test: 'JV-HOTKEY-BENCHMARK',
        target_output: 'name);',
        file_path: 'test_files/java/SimpleAutocomplete.java',
        language_id: 'java',
        cursor_after: 'String message = greet(',
      },
    ], null, 2),
    'utf8',
  );

  const seenRequests = [];
  const provider = {
    async *streamCompletion(request) {
      seenRequests.push({
        interactionMode: request.interactionMode,
        promptCacheKey: request.promptCacheKey,
        context: request.context,
      });
      yield { text: 'name);', done: false };
      yield { text: '', done: true };
    },
  };

  await runAutocompleteBulkTest({
    workspaceFolder,
    output: { appendLine() {} },
    provider,
    languageId: 'java',
    filePath: '/workspace/test_files/java/SimpleAutocomplete.java',
    instructions: 'Return only code',
    promptCacheKey: 'bulk-hotkey',
    benchmarkMode: 'hotkey_inline',
    hotkeySemanticRetryEnabled: false,
    buildContext: () => '{}',
    buildContextForRow: () => JSON.stringify({
      prefix: 'String message = greet(',
      suffix: '',
      beforeLines: ['String message = greet('],
      hash: 'ctx-hash-1',
    }),
    timestamp: new Date(2026, 1, 28, 14, 2, 0),
  });

  assert.equal(seenRequests.length, 1);
  assert.equal(seenRequests[0].interactionMode, 'hotkey');
  assert.equal(seenRequests[0].promptCacheKey, 'bulk-hotkey:fast');
  assert.equal(seenRequests[0].context, undefined);

  const artifactDir = path.join(workspaceFolder, 'test_artifacts');
  const files = await fs.readdir(artifactDir);
  const outputFile = files.find((file) => /^autocomplete_test_output_\d{8}_\d{6}\.csv$/.test(file));
  assert.ok(outputFile, 'expected output CSV file to be created');
  const csv = await fs.readFile(path.join(artifactDir, outputFile), 'utf8');
  assert.match(csv, /JV-HOTKEY-BENCHMARK/);
  assert.match(csv, /,name\);\n/);
});

test('runAutocompleteBulkTest normalizes escaped indentation artifacts in hotkey_inline output', async () => {
  const workspaceFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-autocomplete-bulk-'));
  const inputDir = path.join(workspaceFolder, 'test_files');
  await fs.mkdir(inputDir, { recursive: true });
  await fs.writeFile(
    path.join(inputDir, 'autocomplete_test_input.json'),
    JSON.stringify([
      {
        test: 'GO-HOTKEY-MASKED',
        target_output: 'e',
        file_path: 'test_files/go/simple_autocomplete.go',
        language_id: 'go',
        cursor_after: 'return nam',
      },
    ], null, 2),
    'utf8',
  );

  const provider = {
    async *streamCompletion() {
      yield { text: '\\treturn name', done: false };
      yield { text: '', done: true };
    },
  };

  await runAutocompleteBulkTest({
    workspaceFolder,
    output: { appendLine() {} },
    provider,
    languageId: 'go',
    filePath: '/workspace/test_files/go/simple_autocomplete.go',
    instructions: 'Return only code',
    promptCacheKey: 'bulk-hotkey-go',
    benchmarkMode: 'hotkey_inline',
    hotkeySemanticRetryEnabled: false,
    buildContext: () => '{}',
    buildContextForRow: () => JSON.stringify({
      prefix: ['func maskedWordDemo() string {', '\tname := "Mina"', '\treturn nam'].join('\n'),
      suffix: '\n}',
      linePrefix: '\treturn nam',
      lineSuffix: '',
      beforeLines: ['func maskedWordDemo() string {', '\tname := "Mina"', '\treturn nam'],
      hash: 'ctx-hash-go',
    }),
    timestamp: new Date(2026, 1, 28, 14, 2, 30),
  });

  const artifactDir = path.join(workspaceFolder, 'test_artifacts');
  const files = await fs.readdir(artifactDir);
  const outputFile = files.find((file) => /^autocomplete_test_output_\d{8}_\d{6}\.csv$/.test(file));
  assert.ok(outputFile, 'expected output CSV file to be created');
  const csv = await fs.readFile(path.join(artifactDir, outputFile), 'utf8');
  assert.match(csv, /GO-HOTKEY-MASKED/);
  assert.match(csv, /,e\n/);
});

test('runAutocompleteBulkTest closes bare Python f-string interpolation braces in hotkey_inline output', async () => {
  const workspaceFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-autocomplete-bulk-'));
  const inputDir = path.join(workspaceFolder, 'test_files');
  await fs.mkdir(inputDir, { recursive: true });
  await fs.writeFile(
    path.join(inputDir, 'autocomplete_test_input.json'),
    JSON.stringify([
      {
        test: 'PY-HOTKEY-FSTRING',
        target_output: '}"',
        file_path: 'test_files/python/advanced_autocomplete.py',
        language_id: 'python',
        cursor_after: 'message = f"User {user[\'name\']',
      },
    ], null, 2),
    'utf8',
  );

  const provider = {
    async *streamCompletion() {
      yield { text: '}', done: false };
      yield { text: '', done: true };
    },
  };

  await runAutocompleteBulkTest({
    workspaceFolder,
    output: { appendLine() {} },
    provider,
    languageId: 'python',
    filePath: '/workspace/test_files/python/advanced_autocomplete.py',
    instructions: 'Return only code',
    promptCacheKey: 'bulk-hotkey-py-fstring',
    benchmarkMode: 'hotkey_inline',
    hotkeySemanticRetryEnabled: false,
    buildContext: () => '{}',
    buildContextForRow: () => JSON.stringify({
      prefix: [
        'def run_fstring_case(user: dict[str, str]) -> str:',
        '    message = f"User {user[\'name\']',
      ].join('\n'),
      suffix: '\n    return message\n',
      linePrefix: '    message = f"User {user[\'name\']',
      lineSuffix: '',
      beforeLines: [
        'def run_fstring_case(user: dict[str, str]) -> str:',
        '    message = f"User {user[\'name\']',
      ],
      hash: 'ctx-hash-py-fstring',
    }),
    timestamp: new Date(2026, 1, 28, 14, 2, 45),
  });

  const artifactDir = path.join(workspaceFolder, 'test_artifacts');
  const files = await fs.readdir(artifactDir);
  const outputFile = files.find((file) => /^autocomplete_test_output_\d{8}_\d{6}\.csv$/.test(file));
  assert.ok(outputFile, 'expected output CSV file to be created');
  const csv = await fs.readFile(path.join(artifactDir, outputFile), 'utf8');
  const row = csv.trim().split('\n')[1] ?? '';
  assert.match(row, /^PY-HOTKEY-FSTRING,"}""",/);
  assert.match(row, /,"}"""$/);
});

test('runAutocompleteBulkTest supports direct benchmark mode without fast/full staging', async () => {
  const workspaceFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-autocomplete-bulk-'));
  const inputDir = path.join(workspaceFolder, 'test_files');
  await fs.mkdir(inputDir, { recursive: true });
  await fs.writeFile(
    path.join(inputDir, 'autocomplete_test_input.json'),
    JSON.stringify([
      {
        test: 'JV-DIRECT-BENCHMARK',
        target_output: 'name);',
        file_path: 'test_files/java/SimpleAutocomplete.java',
        language_id: 'java',
        cursor_after: 'String message = greet(',
      },
    ], null, 2),
    'utf8',
  );

  const seenRequests = [];
  const provider = {
    async *streamCompletion(request) {
      seenRequests.push(request);
      yield { text: 'String message = greet(name);', done: false };
      yield { text: '', done: true };
    },
  };

  await runAutocompleteBulkTest({
    workspaceFolder,
    output: { appendLine() {} },
    provider,
    languageId: 'java',
    filePath: '/workspace/test_files/java/SimpleAutocomplete.java',
    instructions: 'Return only code',
    promptCacheKey: 'bulk-direct',
    benchmarkMode: 'direct',
    buildContext: () => '{}',
    buildContextForRow: () => JSON.stringify({
      prefix: 'String message = greet(',
      suffix: '',
      beforeLines: ['String message = greet('],
      hash: 'ctx-hash-direct',
    }),
    timestamp: new Date(2026, 1, 28, 14, 3, 0),
  });

  assert.equal(seenRequests.length, 1);
  assert.equal(seenRequests[0].promptCacheKey, 'bulk-direct');
  assert.equal(seenRequests[0].interactionMode, undefined);
  assert.equal(seenRequests[0].context, undefined);

  const artifactDir = path.join(workspaceFolder, 'test_artifacts');
  const files = await fs.readdir(artifactDir);
  const outputFile = files.find((file) => /^autocomplete_test_output_\d{8}_\d{6}\.csv$/.test(file));
  assert.ok(outputFile, 'expected output CSV file to be created');
  const csv = await fs.readFile(path.join(artifactDir, outputFile), 'utf8');
  assert.match(csv, /JV-DIRECT-BENCHMARK/);
  assert.match(csv, /,name\);\n/);
});

test('runAutocompleteBulkTest filters rows using testPattern', async () => {
  const workspaceFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-autocomplete-bulk-'));
  const inputDir = path.join(workspaceFolder, 'test_files');
  await fs.mkdir(inputDir, { recursive: true });
  await fs.writeFile(
    path.join(inputDir, 'autocomplete_test_input.json'),
    JSON.stringify([
      {
        test: 'ADV-PY-4 Return variable suffix',
        target_output: 'first',
        file_path: 'test_files/python/advanced_autocomplete.py',
        language_id: 'python',
        cursor_after: '    return',
      },
      {
        test: 'PY-1 Simple autocomplete',
        target_output: '"Mina")',
        file_path: 'test_files/python/simple_autocomplete.py',
        language_id: 'python',
        cursor_after: 'message = greet_user(',
      },
    ], null, 2),
    'utf8',
  );

  const logs = [];
  const seenRequests = [];
  const provider = {
    async *streamCompletion(request) {
      seenRequests.push(request);
      yield { text: 'first', done: false };
      yield { text: '', done: true };
    },
  };

  await runAutocompleteBulkTest({
    workspaceFolder,
    output: {
      appendLine(line) {
        logs.push(line);
      },
    },
    provider,
    languageId: 'python',
    filePath: '/workspace/manual_test.py',
    instructions: 'Return only code',
    buildContext: () => '{}',
    buildContextForRow: () => JSON.stringify({
      prefix: '    return',
      suffix: '',
      filePath: 'test_files/python/advanced_autocomplete.py',
      languageId: 'python',
    }),
    maxRetries: 0,
    numericLiteralMismatchMaxRetries: 0,
    semanticMismatchMaxRetries: 0,
    testPattern: 'ADV-PY-4',
    timestamp: new Date(2026, 1, 28, 14, 0, 1),
  });

  assert.equal(seenRequests.length, 1);
  assert.ok(
    logs.some((line) => line.includes('Applied test pattern contains("ADV-PY-4") | matched=1/2')),
  );
  assert.ok(logs.some((line) => line.includes('Processing row 1/1')));

  const artifactDir = path.join(workspaceFolder, 'test_artifacts');
  const files = await fs.readdir(artifactDir);
  const outputFile = files.find((file) => /^autocomplete_test_output_\d{8}_\d{6}\.csv$/.test(file));
  assert.ok(outputFile, 'expected output CSV file to be created');
  const csv = await fs.readFile(path.join(artifactDir, outputFile), 'utf8');
  assert.match(csv, /ADV-PY-4 Return variable suffix/);
  assert.doesNotMatch(csv, /PY-1 Simple autocomplete/);
});

test('runAutocompleteBulkTest extracts prefix/suffix from context JSON and normalizes output', async () => {
  const workspaceFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-autocomplete-bulk-'));
  const inputDir = path.join(workspaceFolder, 'test_files');
  await fs.mkdir(inputDir, { recursive: true });
  await fs.writeFile(
    path.join(inputDir, 'autocomplete_test_input.json'),
    JSON.stringify([
      {
        test: 'JV-NORM-1',
        target_output: 'name);',
        file_path: 'test_files/java/SimpleAutocomplete.java',
        language_id: 'java',
        cursor_after: 'String message = greet(',
      },
    ], null, 2),
    'utf8',
  );

  const seenRequests = [];
  const provider = {
    async *streamCompletion(request) {
      seenRequests.push(request);
      yield { text: 'String message = greet(name);', done: false };
      yield { text: '', done: true };
    },
  };

  await runAutocompleteBulkTest({
    workspaceFolder,
    output: { appendLine() {} },
    provider,
    languageId: 'java',
    filePath: '/workspace/test_files/java/SimpleAutocomplete.java',
    instructions: 'Return only code',
    buildContext: () => '{}',
    buildContextForRow: () => JSON.stringify({
      prefix: 'String message = greet(',
      suffix: '',
      filePath: 'test_files/java/SimpleAutocomplete.java',
      languageId: 'java',
    }),
    timestamp: new Date(2026, 1, 28, 14, 5, 0),
  });

  assert.equal(seenRequests.length, 1);
  assert.equal(seenRequests[0].prefix, 'String message = greet(');
  assert.equal(seenRequests[0].suffix, '');

  const artifactDir = path.join(workspaceFolder, 'test_artifacts');
  const files = await fs.readdir(artifactDir);
  const outputFile = files.find((file) => /^autocomplete_test_output_\d{8}_\d{6}\.csv$/.test(file));
  assert.ok(outputFile, 'expected output CSV file to be created');

  const csv = await fs.readFile(path.join(artifactDir, outputFile), 'utf8');
  assert.match(csv, /JV-NORM-1/);
  assert.match(csv, /,name\);\n/);
});

test('runAutocompleteBulkTest uses staged hotkey fallback after empty fast-stage output', async () => {
  const workspaceFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-autocomplete-bulk-'));
  const inputDir = path.join(workspaceFolder, 'test_files');
  await fs.mkdir(inputDir, { recursive: true });
  await fs.writeFile(
    path.join(inputDir, 'autocomplete_test_input.json'),
    JSON.stringify([
      {
        test: 'PY-RETRY-EMPTY',
        target_output: ')[0]',
        file_path: 'test_files/python/large_autocomplete.py',
        language_id: 'python',
        cursor_after: 'return text.splitlines(',
      },
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
  const provider = {
    async *streamCompletion(request) {
      seenRequests.push(request);
      if (seenRequests.length === 1) {
        yield { text: '', done: false };
      } else {
        yield { text: '[0]', done: false };
      }
      yield { text: '', done: true };
    },
  };

  await runAutocompleteBulkTest({
    workspaceFolder,
    output,
    provider,
    languageId: 'python',
    filePath: '/workspace/test_files/python/large_autocomplete.py',
    instructions: 'Return only code',
    promptCacheKey: 'bulk-empty-fallback',
    hotkeySemanticRetryEnabled: false,
    buildContext: () => '{}',
    buildContextForRow: () => JSON.stringify({
      prefix: 'def quick_check() -> str:\n    text = build_report(METRICS)\n    return text.splitlines(',
      suffix: '',
      filePath: 'test_files/python/large_autocomplete.py',
      languageId: 'python',
    }),
    timestamp: new Date(2026, 1, 28, 14, 7, 0),
  });

  assert.equal(seenRequests.length, 2);
  assert.equal(seenRequests[0].promptCacheKey, 'bulk-empty-fallback:fast');
  assert.equal(seenRequests[1].promptCacheKey, 'bulk-empty-fallback:full');
  assert.doesNotMatch(seenRequests[0].instructions ?? '', /Retry reason:/);
  assert.ok(logs.every((line) => !line.includes('reason=empty_output')));

  const artifactDir = path.join(workspaceFolder, 'test_artifacts');
  const files = await fs.readdir(artifactDir);
  const outputFile = files.find((file) => /^autocomplete_test_output_\d{8}_\d{6}\.csv$/.test(file));
  assert.ok(outputFile, 'expected output CSV file to be created');
  const csv = await fs.readFile(path.join(artifactDir, outputFile), 'utf8');
  assert.match(csv, /PY-RETRY-EMPTY/);
  assert.match(csv, /\)\[0\]/);
});

test('runAutocompleteBulkTest retries empty direct-mode blank-line responses', async () => {
  const workspaceFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-autocomplete-bulk-'));
  const inputDir = path.join(workspaceFolder, 'test_files');
  await fs.mkdir(inputDir, { recursive: true });
  await fs.writeFile(
    path.join(inputDir, 'autocomplete_test_input.json'),
    JSON.stringify([
      {
        test: 'PY-DIRECT-EMPTY-BLANK-LINE',
        target_output: 'pass',
        file_path: 'test_files/python/blank_line_autocomplete.py',
        language_id: 'python',
        cursor_after: '    ',
      },
    ], null, 2),
    'utf8',
  );

  const logs = [];
  const seenRequests = [];
  const provider = {
    async *streamCompletion(request) {
      seenRequests.push(request);
      yield { text: '', done: false };
      yield { text: '', done: true };
    },
  };

  await runAutocompleteBulkTest({
    workspaceFolder,
    output: {
      appendLine(line) {
        logs.push(line);
      },
    },
    provider,
    languageId: 'python',
    filePath: '/workspace/test_files/python/blank_line_autocomplete.py',
    instructions: 'Return only code',
    benchmarkMode: 'direct',
    buildContext: () => '{}',
    buildContextForRow: () => JSON.stringify({
      prefix: 'def run_blank_case() -> None:\n    ',
      suffix: '\n    return None\n',
      linePrefix: '    ',
      lineSuffix: '',
      beforeLines: ['def run_blank_case() -> None:', '    '],
      filePath: 'test_files/python/blank_line_autocomplete.py',
      languageId: 'python',
    }),
    timestamp: new Date(2026, 1, 28, 14, 7, 15),
  });

  assert.equal(seenRequests.length, 2);
  assert.ok(logs.some((line) => line.includes('reason=empty_output')));

  const artifactDir = path.join(workspaceFolder, 'test_artifacts');
  const files = await fs.readdir(artifactDir);
  const outputFile = files.find((file) => /^autocomplete_test_output_\d{8}_\d{6}\.csv$/.test(file));
  assert.ok(outputFile, 'expected output CSV file to be created');
  const csv = await fs.readFile(path.join(artifactDir, outputFile), 'utf8');
  assert.match(csv, /PY-DIRECT-EMPTY-BLANK-LINE/);
  assert.match(csv, /PY-DIRECT-EMPTY-BLANK-LINE/);
});

test('runAutocompleteBulkTest retries direct-mode outputs that normalize to blank after duplicate suffix removal', async () => {
  const workspaceFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-autocomplete-bulk-'));
  const inputDir = path.join(workspaceFolder, 'test_files');
  await fs.mkdir(inputDir, { recursive: true });
  await fs.writeFile(
    path.join(inputDir, 'autocomplete_test_input.json'),
    JSON.stringify([
      {
        test: 'PY-DIRECT-DUPLICATE-SUFFIX-FALLBACK',
        target_output: 'message2',
        file_path: 'test_files/python/blank_line_autocomplete.py',
        language_id: 'python',
        cursor_after: '    ',
      },
    ], null, 2),
    'utf8',
  );

  const seenRequests = [];
  const provider = {
    async *streamCompletion(request) {
      seenRequests.push(request);
      yield { text: 'print(message2)', done: false };
      yield { text: '', done: true };
    },
  };

  await runAutocompleteBulkTest({
    workspaceFolder,
    output: { appendLine() {} },
    provider,
    languageId: 'python',
    filePath: '/workspace/test_files/python/blank_line_autocomplete.py',
    instructions: 'Return only code',
    benchmarkMode: 'direct',
    buildContext: () => '{}',
    buildContextForRow: () => JSON.stringify({
      prefix: [
        'def suffix_midline_demo() -> None:',
        '    message2 = greet_user()',
        '    ',
      ].join('\n'),
      suffix: '    print(message2)\n',
      linePrefix: '    ',
      lineSuffix: '',
      beforeLines: [
        'def suffix_midline_demo() -> None:',
        '    message2 = greet_user()',
        '    ',
      ],
      filePath: 'test_files/python/blank_line_autocomplete.py',
      languageId: 'python',
    }),
    timestamp: new Date(2026, 1, 28, 14, 7, 30),
  });

  assert.equal(seenRequests.length, 2);

  const artifactDir = path.join(workspaceFolder, 'test_artifacts');
  const files = await fs.readdir(artifactDir);
  const outputFile = files.find((file) => /^autocomplete_test_output_\d{8}_\d{6}\.csv$/.test(file));
  assert.ok(outputFile, 'expected output CSV file to be created');
  const csv = await fs.readFile(path.join(artifactDir, outputFile), 'utf8');
  assert.match(csv, /PY-DIRECT-DUPLICATE-SUFFIX-FALLBACK/);
  assert.match(csv, /PY-DIRECT-DUPLICATE-SUFFIX-FALLBACK/);
});

test('runAutocompleteBulkTest retries empty hotkey_inline template-closure responses', async () => {
  const workspaceFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-autocomplete-bulk-'));
  const inputDir = path.join(workspaceFolder, 'test_files');
  await fs.mkdir(inputDir, { recursive: true });
  await fs.writeFile(
    path.join(inputDir, 'autocomplete_test_input.json'),
    JSON.stringify([
      {
        test: 'TS-HOTKEY-EMPTY-TEMPLATE-FALLBACK',
        target_output: '}`',
        file_path: 'test_files/typescript/advanced_autocomplete.ts',
        language_id: 'typescript',
        cursor_after: '  const label = `Invoice ${invoice.id',
      },
    ], null, 2),
    'utf8',
  );

  const logs = [];
  const seenRequests = [];
  const provider = {
    async *streamCompletion(request) {
      seenRequests.push(request);
      yield { text: '', done: false };
      yield { text: '', done: true };
    },
  };

  await runAutocompleteBulkTest({
    workspaceFolder,
    output: {
      appendLine(line) {
        logs.push(line);
      },
    },
    provider,
    languageId: 'typescript',
    filePath: '/workspace/test_files/typescript/advanced_autocomplete.ts',
    instructions: 'Return only code',
    benchmarkMode: 'hotkey_inline',
    hotkeySemanticRetryEnabled: false,
    buildContext: () => '{}',
    buildContextForRow: () => JSON.stringify({
      prefix: [
        'export function runTemplateLiteralCase(invoice: { id: string; total: number }): string {',
        '  const label = `Invoice ${invoice.id',
      ].join('\n'),
      suffix: '\n  return label;\n}\n',
      linePrefix: '  const label = `Invoice ${invoice.id',
      lineSuffix: '',
      beforeLines: [
        'export function runTemplateLiteralCase(invoice: { id: string; total: number }): string {',
        '  const label = `Invoice ${invoice.id',
      ],
      hash: 'ctx-hash-template-empty',
      filePath: 'test_files/typescript/advanced_autocomplete.ts',
      languageId: 'typescript',
    }),
    timestamp: new Date(2026, 1, 28, 14, 7, 45),
  });

  assert.equal(seenRequests.length, 8);
  assert.ok(logs.some((line) => line.includes('reason=empty_output')));

  const artifactDir = path.join(workspaceFolder, 'test_artifacts');
  const files = await fs.readdir(artifactDir);
  const outputFile = files.find((file) => /^autocomplete_test_output_\d{8}_\d{6}\.csv$/.test(file));
  assert.ok(outputFile, 'expected output CSV file to be created');
  const csv = await fs.readFile(path.join(artifactDir, outputFile), 'utf8');
  assert.match(csv, /TS-HOTKEY-EMPTY-TEMPLATE-FALLBACK/);
  assert.match(csv, /}\`/);
});

test('runAutocompleteBulkTest retries twice on numeric literal mismatch by default', async () => {
  const workspaceFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-autocomplete-bulk-'));
  const inputDir = path.join(workspaceFolder, 'test_files');
  await fs.mkdir(inputDir, { recursive: true });
  await fs.writeFile(
    path.join(inputDir, 'autocomplete_test_input.json'),
    JSON.stringify([
      {
        test: 'JV-RETRY-NUMERIC',
        target_output: 'cart, coupon, 0.07);',
        file_path: 'test_files/java/ComplexAutocomplete.java',
        language_id: 'java',
        cursor_after: 'double total = checkoutTotal(',
      },
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
  const provider = {
    async *streamCompletion(request) {
      seenRequests.push(request);
      if (seenRequests.length === 1) {
        yield { text: 'cart, coupon, 0.0825);', done: false };
      } else if (seenRequests.length === 2) {
        yield { text: 'cart, coupon, 0.08);', done: false };
      } else {
        yield { text: 'cart, coupon, 0.07);', done: false };
      }
      yield { text: '', done: true };
    },
  };

  await runAutocompleteBulkTest({
    workspaceFolder,
    output,
    provider,
    languageId: 'java',
    filePath: '/workspace/test_files/java/ComplexAutocomplete.java',
    instructions: 'Return only code',
    hotkeySemanticRetryEnabled: false,
    buildContext: () => '{}',
    buildContextForRow: () => JSON.stringify({
      prefix: 'double total = checkoutTotal(',
      suffix: '',
      filePath: 'test_files/java/ComplexAutocomplete.java',
      languageId: 'java',
    }),
    timestamp: new Date(2026, 1, 28, 14, 8, 0),
  });

  assert.equal(seenRequests.length, 3);
  assert.match(
    seenRequests[1].instructions ?? '',
    /Retry reason: numeric_literal_mismatch/,
  );
  assert.match(
    seenRequests[2].instructions ?? '',
    /Retry reason: numeric_literal_mismatch/,
  );
  assert.match(
    seenRequests[1].instructions ?? '',
    /REQUIRED_NUMERIC_LITERALS: 0\.07/,
  );
  assert.match(
    seenRequests[1].instructions ?? '',
    /Preserve required numeric literals exactly as implied by cursor scenario\./,
  );
  assert.ok(logs.some((line) => line.includes('retrying attempt 2/3 reason=numeric_literal_mismatch')));
  assert.ok(logs.some((line) => line.includes('retrying attempt 3/3 reason=numeric_literal_mismatch')));
  assert.ok(logs.some((line) => line.includes('attempts=3/3')));

  const artifactDir = path.join(workspaceFolder, 'test_artifacts');
  const files = await fs.readdir(artifactDir);
  const outputFile = files.find((file) => /^autocomplete_test_output_\d{8}_\d{6}\.csv$/.test(file));
  assert.ok(outputFile, 'expected output CSV file to be created');
  const csv = await fs.readFile(path.join(artifactDir, outputFile), 'utf8');
  assert.match(csv, /JV-RETRY-NUMERIC/);
  assert.match(csv, /cart, coupon, 0\.07\);/);
});

test('runAutocompleteBulkTest retries twice on semantic mismatch by default budget', async () => {
  const workspaceFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-autocomplete-bulk-'));
  const inputDir = path.join(workspaceFolder, 'test_files');
  await fs.mkdir(inputDir, { recursive: true });
  await fs.writeFile(
    path.join(inputDir, 'autocomplete_test_input.json'),
    JSON.stringify([
      {
        test: 'TS-RETRY-SEMANTIC',
        target_output: 'user.name)',
        file_path: 'test_files/python/cross_file_consumer.py',
        language_id: 'python',
        cursor_after: 'message = greet(',
        lock_arg_form: true,
      },
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
  const provider = {
    async *streamCompletion(request) {
      seenRequests.push(request);
      if (seenRequests.length <= 2) {
        yield { text: 'user)', done: false };
      } else {
        yield { text: 'user.name)', done: false };
      }
      yield { text: '', done: true };
    },
  };

  await runAutocompleteBulkTest({
    workspaceFolder,
    output,
    provider,
    languageId: 'python',
    filePath: '/workspace/test_files/python/cross_file_consumer.py',
    instructions: 'Return only code',
    hotkeySemanticRetryEnabled: false,
    buildContext: () => '{}',
    buildContextForRow: () => JSON.stringify({
      prefix: 'message = greet(',
      suffix: '',
      filePath: 'test_files/python/cross_file_consumer.py',
      languageId: 'python',
    }),
    timestamp: new Date(2026, 1, 28, 14, 9, 0),
  });

  assert.equal(seenRequests.length, 3);
  assert.match(seenRequests[1].instructions ?? '', /Retry reason: semantic_mismatch/);
  assert.match(seenRequests[2].instructions ?? '', /Retry reason: semantic_mismatch/);
  assert.match(
    seenRequests[1].instructions ?? '',
    /REQUIRED_IDENTIFIERS: user, name/,
  );
  assert.match(
    seenRequests[1].instructions ?? '',
    /LOCK_ARG_FORM: enabled/,
  );
  assert.ok(logs.some((line) => line.includes('retrying attempt 2/3 reason=semantic_mismatch')));
  assert.ok(logs.some((line) => line.includes('retrying attempt 3/3 reason=semantic_mismatch')));
  assert.ok(logs.some((line) => line.includes('attempts=3/3')));

  const artifactDir = path.join(workspaceFolder, 'test_artifacts');
  const files = await fs.readdir(artifactDir);
  const outputFile = files.find((file) => /^autocomplete_test_output_\d{8}_\d{6}\.csv$/.test(file));
  assert.ok(outputFile, 'expected output CSV file to be created');
  const csv = await fs.readFile(path.join(artifactDir, outputFile), 'utf8');
  assert.match(csv, /TS-RETRY-SEMANTIC/);
  assert.match(csv, /,user\.name\)\n/);
});

test('runAutocompleteBulkTest semantic guard retries known mismatch regressions (rows 1/34/36/37/40/42/45)', async () => {
  const scenarios = [
    {
      label: 'ROW-1',
      targetOutput: '"Mina")',
      badOutput: 'profile)',
      filePath: 'test_files/python/simple_autocomplete.py',
      languageId: 'python',
      cursorAfter: 'message = greet_user(',
      rowFlags: { lock_quotes: true, lock_arg_form: true },
      expectArgOrderInstruction: false,
    },
    {
      label: 'ROW-34',
      targetOutput: '25, order_by="created_at")',
      badOutput: 'order_by="created_at", limit=25',
      filePath: 'test_files/python/advanced_autocomplete.py',
      languageId: 'python',
      cursorAfter: 'query = build_query("users", filters, ',
      rowFlags: { lock_quotes: true, lock_arg_form: true },
      expectArgOrderInstruction: true,
    },
    {
      label: 'ROW-36',
      targetOutput: '",")[0]',
      badOutput: '", ")[0]',
      filePath: 'test_files/python/advanced_autocomplete.py',
      languageId: 'python',
      cursorAfter: 'first = summarize_metrics(metrics, include_inactive=False, precision=2).split(',
      rowFlags: { lock_quotes: true, lock_arg_form: true, lock_delimiter_spacing: true },
      expectArgOrderInstruction: false,
    },
    {
      label: 'ROW-37',
      targetOutput: ' first',
      badOutput: ' first[0]',
      filePath: 'test_files/python/advanced_autocomplete.py',
      languageId: 'python',
      cursorAfter: '    return',
      rowFlags: {},
      expectArgOrderInstruction: false,
    },
    {
      label: 'ROW-40',
      targetOutput: '0.07, "USD");',
      badOutput: '"USD", 0.07);',
      filePath: 'test_files/java/AdvancedAutocomplete.java',
      languageId: 'java',
      cursorAfter: 'String summary = buildSummary("C-100", amounts, ',
      rowFlags: { lock_quotes: true, lock_arg_form: true },
      expectArgOrderInstruction: true,
    },
    {
      label: 'ROW-42',
      targetOutput: 'Collectors.joining(", "));',
      badOutput: 'Collectors.joining(","));',
      filePath: 'test_files/java/AdvancedAutocomplete.java',
      languageId: 'java',
      cursorAfter: ').collect(',
      rowFlags: { lock_quotes: true, lock_arg_form: true, lock_delimiter_spacing: true },
      expectArgOrderInstruction: false,
    },
    {
      label: 'ROW-45',
      targetOutput: 'cart, coupon, 0.07);',
      badOutput: 'cart, coupon, draftCoupon, 0.07);',
      filePath: 'test_files/java/ComplexAutocomplete.java',
      languageId: 'java',
      cursorAfter: 'double total = checkoutTotal(',
      rowFlags: {},
      expectArgOrderInstruction: true,
    },
  ];

  for (const [index, scenario] of scenarios.entries()) {
    const workspaceFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-autocomplete-bulk-'));
    const inputDir = path.join(workspaceFolder, 'test_files');
    await fs.mkdir(inputDir, { recursive: true });
    await fs.writeFile(
      path.join(inputDir, 'autocomplete_test_input.json'),
      JSON.stringify([
        {
          test: `${scenario.label} semantic mismatch regression`,
          target_output: scenario.targetOutput,
          file_path: scenario.filePath,
          language_id: scenario.languageId,
          cursor_after: scenario.cursorAfter,
          ...scenario.rowFlags,
        },
      ], null, 2),
      'utf8',
    );

    const logs = [];
    const seenRequests = [];
    const provider = {
      async *streamCompletion(request) {
        seenRequests.push(request);
        if (seenRequests.length === 1) {
          yield { text: scenario.badOutput, done: false };
        } else {
          yield { text: scenario.targetOutput, done: false };
        }
        yield { text: '', done: true };
      },
    };

    await runAutocompleteBulkTest({
      workspaceFolder,
      output: {
        appendLine(line) {
          logs.push(line);
        },
      },
      provider,
      languageId: scenario.languageId,
      filePath: path.join('/workspace', scenario.filePath),
      instructions: 'Return only code',
      hotkeySemanticRetryEnabled: false,
      buildContext: () => '{}',
      buildContextForRow: () => JSON.stringify({
        prefix: scenario.cursorAfter,
        suffix: '',
        filePath: scenario.filePath,
        languageId: scenario.languageId,
      }),
      timestamp: new Date(2026, 1, 28, 14, 10, index),
    });

    assert.equal(
      seenRequests.length,
      2,
      `${scenario.label} should trigger exactly one semantic retry`,
    );
    assert.match(
      seenRequests[1].instructions ?? '',
      /Retry reason: semantic_m/,
      `${scenario.label} should include semantic retry reason`,
    );
    if (scenario.targetOutput.includes('"') || scenario.targetOutput.includes('`') || scenario.targetOutput.includes('\'')) {
      assert.match(
        seenRequests[1].instructions ?? '',
        /REQUIRED_STRING_LITERAL_LOCK: enabled/,
        `${scenario.label} should include required string literal lock guidance`,
      );
    }
    if (scenario.expectArgOrderInstruction) {
      assert.match(
        seenRequests[1].instructions ?? '',
        /REQUIRED_ARG_SEQUENCE:/,
        `${scenario.label} should include required argument order hints`,
      );
    }
    assert.ok(
      logs.some((line) => line.includes('retrying attempt 2/3 reason=semantic_mismatch')),
      `${scenario.label} should log semantic retry`,
    );
  }
});

test('runAutocompleteBulkTest does not apply target-derived locks for <scenario-dependent> rows', async () => {
  const workspaceFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-autocomplete-bulk-'));
  const inputDir = path.join(workspaceFolder, 'test_files');
  await fs.mkdir(inputDir, { recursive: true });
  await fs.writeFile(
    path.join(inputDir, 'autocomplete_test_input.json'),
    JSON.stringify([
      {
        test: 'BOUNDARY-SCENARIO-1',
        target_output: '<scenario-dependent>',
        file_path: 'test_files/typescript/large_autocomplete.ts',
        language_id: 'typescript',
        cursor_after: 'return summarizePriority(',
      },
    ], null, 2),
    'utf8',
  );

  const seenRequests = [];
  const provider = {
    async *streamCompletion(request) {
      seenRequests.push(request);
      yield { text: 'scenario, dependent);', done: false };
      yield { text: '', done: true };
    },
  };

  await runAutocompleteBulkTest({
    workspaceFolder,
    output: { appendLine() {} },
    provider,
    languageId: 'typescript',
    filePath: '/workspace/test_files/typescript/large_autocomplete.ts',
    instructions: 'Return only code',
    hotkeySemanticRetryEnabled: false,
    buildContext: () => '{}',
    buildContextForRow: () => JSON.stringify({
      prefix: 'return summarizePriority(',
      suffix: '\n}',
      filePath: 'test_files/typescript/large_autocomplete.ts',
      languageId: 'typescript',
    }),
    timestamp: new Date(2026, 1, 28, 18, 0, 0),
  });

  assert.equal(seenRequests.length, 1);
  const instructions = seenRequests[0].instructions ?? '';
  assert.match(instructions, /REQUIRED_EXACT_SUFFIX_SNIPPET: <none>/);
  assert.match(instructions, /REQUIRED_IDENTIFIERS: <none>/);
  assert.match(instructions, /REQUIRED_STRING_LITERALS: <none>/);
  assert.doesNotMatch(instructions, /<scenario-dependent>/);
});

test('runAutocompleteBulkTest rejects JSON rows without explicit target_output', async () => {
  const workspaceFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-autocomplete-bulk-'));
  const inputDir = path.join(workspaceFolder, 'test_files');
  await fs.mkdir(inputDir, { recursive: true });
  await fs.writeFile(
    path.join(inputDir, 'autocomplete_test_input.json'),
    JSON.stringify([{ test: 'PY-1 | simple call' }], null, 2),
    'utf8',
  );

  const logs = [];
  const output = {
    appendLine(line) {
      logs.push(line);
    },
  };

  const provider = {
    async *streamCompletion() {
      yield { text: 'unused', done: false };
      yield { text: '', done: true };
    },
  };

  await runAutocompleteBulkTest({
    workspaceFolder,
    output,
    provider,
    languageId: 'python',
    filePath: '/workspace/manual_test.py',
    instructions: 'Return only code',
    buildContext: () => '{}',
  });

  assert.ok(
    logs.some((line) => line.includes('missing required "target_output"')),
    'expected explicit target_output validation error',
  );
});

test('runAutocompleteBulkTest rejects invalid optional cursor metadata', async () => {
  const workspaceFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-autocomplete-bulk-'));
  const inputDir = path.join(workspaceFolder, 'test_files');
  await fs.mkdir(inputDir, { recursive: true });
  await fs.writeFile(
    path.join(inputDir, 'autocomplete_test_input.json'),
    JSON.stringify([
      {
        test: 'PY-1 | invalid cursor metadata',
        target_output: '"Mina")',
        cursor_after_occurrence: 0,
      },
    ], null, 2),
    'utf8',
  );

  const logs = [];
  const output = {
    appendLine(line) {
      logs.push(line);
    },
  };

  const provider = {
    async *streamCompletion() {
      yield { text: 'unused', done: false };
      yield { text: '', done: true };
    },
  };

  await runAutocompleteBulkTest({
    workspaceFolder,
    output,
    provider,
    languageId: 'python',
    filePath: '/workspace/manual_test.py',
    instructions: 'Return only code',
    buildContext: () => '{}',
  });

  assert.ok(
    logs.some((line) => line.includes('invalid "cursor_after_occurrence"')),
    'expected invalid optional metadata validation error',
  );
});
