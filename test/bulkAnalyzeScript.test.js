require('./helpers/registerVscode.js');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function runAnalyzer(args) {
  return spawnSync(
    process.execPath,
    [path.join(process.cwd(), 'scripts', 'analyze-bulk-autocomplete-output.js'), ...args],
    { encoding: 'utf8' },
  );
}

test('bulk analyzer supports strict and tolerant scoring modes', async () => {
  const workspaceFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-autocomplete-analyze-'));
  const artifactDir = path.join(workspaceFolder, 'test_artifacts');
  await fs.mkdir(artifactDir, { recursive: true });
  const csvPath = path.join(artifactDir, 'autocomplete_test_output_20260228_190000.csv');
  await fs.writeFile(
    csvPath,
    [
      'test,target_output,context,output',
      '"TS-NUMERIC-1","items, ""USD"", 0.07);","{}","items, ""USD"", 0.0700);"',
    ].join('\n'),
    'utf8',
  );

  const strictRun = runAnalyzer([
    '--workspace',
    workspaceFolder,
    '--file',
    csvPath,
    '--mode',
    'strict',
    '--no-write',
  ]);
  assert.equal(strictRun.status, 0, strictRun.stderr);
  assert.match(strictRun.stdout, /mode=strict/);
  assert.match(strictRun.stdout, /failures=1/);
  assert.match(strictRun.stdout, /semantic_failures=1/);
  assert.match(strictRun.stdout, /punctuation_failures=0/);

  const tolerantRun = runAnalyzer([
    '--workspace',
    workspaceFolder,
    '--file',
    csvPath,
    '--mode',
    'tolerant',
    '--no-write',
  ]);
  assert.equal(tolerantRun.status, 0, tolerantRun.stderr);
  assert.match(tolerantRun.stdout, /mode=tolerant/);
  assert.match(tolerantRun.stdout, /failures=0/);
  assert.match(tolerantRun.stdout, /tolerant_semantic_match: 1/);
  assert.match(tolerantRun.stdout, /semantic_failures=0/);
  assert.match(tolerantRun.stdout, /punctuation_failures=0/);
});

test('bulk analyzer treats escaped newline as normalized match in strict mode', async () => {
  const workspaceFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-autocomplete-analyze-'));
  const artifactDir = path.join(workspaceFolder, 'test_artifacts');
  await fs.mkdir(artifactDir, { recursive: true });
  const csvPath = path.join(artifactDir, 'autocomplete_test_output_20260228_190100.csv');
  await fs.writeFile(
    csvPath,
    [
      'test,target_output,context,output',
      '"JV-SIMPLE-1","name);","{}","name);\\n"',
    ].join('\n'),
    'utf8',
  );

  const strictRun = runAnalyzer([
    '--workspace',
    workspaceFolder,
    '--file',
    csvPath,
    '--mode',
    'strict',
    '--no-write',
  ]);
  assert.equal(strictRun.status, 0, strictRun.stderr);
  assert.match(strictRun.stdout, /mode=strict/);
  assert.match(strictRun.stdout, /normalized_only_matches=1/);
  assert.match(strictRun.stdout, /failures=0/);
});

test('bulk analyzer applies optional semicolon tolerance in tolerant mode', async () => {
  const workspaceFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-autocomplete-analyze-'));
  const artifactDir = path.join(workspaceFolder, 'test_artifacts');
  await fs.mkdir(artifactDir, { recursive: true });
  const csvPath = path.join(artifactDir, 'autocomplete_test_output_20260228_190200.csv');
  await fs.writeFile(
    csvPath,
    [
      'test,target_output,context,output',
      '"DOC-TS Semicolon policy | file=test_files/typescript/suggestion_documentation.ts","badge);","{}","badge)"',
    ].join('\n'),
    'utf8',
  );

  const strictRun = runAnalyzer([
    '--workspace',
    workspaceFolder,
    '--file',
    csvPath,
    '--mode',
    'strict',
    '--no-write',
  ]);
  assert.equal(strictRun.status, 0, strictRun.stderr);
  assert.match(strictRun.stdout, /mode=strict/);
  assert.match(strictRun.stdout, /failures=1/);
  assert.match(strictRun.stdout, /semantic_failures=0/);
  assert.match(strictRun.stdout, /punctuation_failures=1/);

  const tolerantRun = runAnalyzer([
    '--workspace',
    workspaceFolder,
    '--file',
    csvPath,
    '--mode',
    'tolerant',
    '--no-write',
  ]);
  assert.equal(tolerantRun.status, 0, tolerantRun.stderr);
  assert.match(tolerantRun.stdout, /mode=tolerant/);
  assert.match(tolerantRun.stdout, /failures=0/);
  assert.match(tolerantRun.stdout, /tolerant_semicolon_optional: 1/);
});

test('bulk analyzer treats closing template token semicolon difference as tolerant semicolon optional', async () => {
  const workspaceFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-autocomplete-analyze-'));
  const artifactDir = path.join(workspaceFolder, 'test_artifacts');
  await fs.mkdir(artifactDir, { recursive: true });
  const csvPath = path.join(artifactDir, 'autocomplete_test_output_20260228_190212.csv');
  await fs.writeFile(
    csvPath,
    [
      'test,target_output,context,output',
      '"TS-TEMPLATE-CLOSE | file=test_files/typescript/patterns_autocomplete.ts","}`","{}","}`;"',
    ].join('\n'),
    'utf8',
  );

  const strictRun = runAnalyzer([
    '--workspace',
    workspaceFolder,
    '--file',
    csvPath,
    '--mode',
    'strict',
    '--no-write',
  ]);
  assert.equal(strictRun.status, 0, strictRun.stderr);
  assert.match(strictRun.stdout, /mode=strict/);
  assert.match(strictRun.stdout, /failures=1/);
  assert.match(strictRun.stdout, /punctuation_failures=1/);
  assert.match(strictRun.stdout, /partial_overlap: 1/);

  const tolerantRun = runAnalyzer([
    '--workspace',
    workspaceFolder,
    '--file',
    csvPath,
    '--mode',
    'tolerant',
    '--no-write',
  ]);
  assert.equal(tolerantRun.status, 0, tolerantRun.stderr);
  assert.match(tolerantRun.stdout, /mode=tolerant/);
  assert.match(tolerantRun.stdout, /failures=0/);
  assert.match(tolerantRun.stdout, /tolerant_semicolon_optional: 1/);
});

test('bulk analyzer applies optional semicolon tolerance for C# suffix rows', async () => {
  const workspaceFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-autocomplete-analyze-'));
  const artifactDir = path.join(workspaceFolder, 'test_artifacts');
  await fs.mkdir(artifactDir, { recursive: true });
  const csvPath = path.join(artifactDir, 'autocomplete_test_output_20260228_190225.csv');
  await fs.writeFile(
    csvPath,
    [
      'test,target_output,context,output',
      '"CS-SEMICOLON | file=test_files/csharp/simple_autocomplete.cs","ty","{}","ty;"',
    ].join('\n'),
    'utf8',
  );

  const strictRun = runAnalyzer([
    '--workspace',
    workspaceFolder,
    '--file',
    csvPath,
    '--mode',
    'strict',
    '--no-write',
  ]);
  assert.equal(strictRun.status, 0, strictRun.stderr);
  assert.match(strictRun.stdout, /mode=strict/);
  assert.match(strictRun.stdout, /failures=1/);

  const tolerantRun = runAnalyzer([
    '--workspace',
    workspaceFolder,
    '--file',
    csvPath,
    '--mode',
    'tolerant',
    '--no-write',
  ]);
  assert.equal(tolerantRun.status, 0, tolerantRun.stderr);
  assert.match(tolerantRun.stdout, /mode=tolerant/);
  assert.match(tolerantRun.stdout, /failures=0/);
  assert.match(tolerantRun.stdout, /tolerant_semicolon_optional: 1/);
});

test('bulk analyzer applies tolerant TS object key-order equivalence', async () => {
  const workspaceFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-autocomplete-analyze-'));
  const artifactDir = path.join(workspaceFolder, 'test_artifacts');
  await fs.mkdir(artifactDir, { recursive: true });
  const csvPath = path.join(artifactDir, 'autocomplete_test_output_20260228_190250.csv');
  await fs.writeFile(
    csvPath,
    [
      'test,target_output,context,output',
      '"ADV-TS-1 | file=test_files/typescript/advanced_autocomplete.ts","{ taxRate: 0.07, currency: ""USD"" });","{}","{ currency: ""USD"", taxRate: 0.07 });"',
    ].join('\n'),
    'utf8',
  );

  const strictRun = runAnalyzer([
    '--workspace',
    workspaceFolder,
    '--file',
    csvPath,
    '--mode',
    'strict',
    '--no-write',
  ]);
  assert.equal(strictRun.status, 0, strictRun.stderr);
  assert.match(strictRun.stdout, /failures=1/);

  const tolerantRun = runAnalyzer([
    '--workspace',
    workspaceFolder,
    '--file',
    csvPath,
    '--mode',
    'tolerant',
    '--no-write',
  ]);
  assert.equal(tolerantRun.status, 0, tolerantRun.stderr);
  assert.match(tolerantRun.stdout, /failures=0/);
  assert.match(tolerantRun.stdout, /tolerant_object_key_order: 1/);
});

test('bulk analyzer applies tolerant Python kwarg reorder equivalence when values match', async () => {
  const workspaceFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-autocomplete-analyze-'));
  const artifactDir = path.join(workspaceFolder, 'test_artifacts');
  await fs.mkdir(artifactDir, { recursive: true });
  const csvPath = path.join(artifactDir, 'autocomplete_test_output_20260228_190275.csv');
  await fs.writeFile(
    csvPath,
    [
      'test,target_output,context,output',
      '"ADV-PY-KWARG-1 | file=test_files/python/advanced_autocomplete.py","order_by=""created_at"", limit=25)","{}","limit=25, order_by=""created_at"")"',
    ].join('\n'),
    'utf8',
  );

  const strictRun = runAnalyzer([
    '--workspace',
    workspaceFolder,
    '--file',
    csvPath,
    '--mode',
    'strict',
    '--no-write',
  ]);
  assert.equal(strictRun.status, 0, strictRun.stderr);
  assert.match(strictRun.stdout, /failures=1/);

  const tolerantRun = runAnalyzer([
    '--workspace',
    workspaceFolder,
    '--file',
    csvPath,
    '--mode',
    'tolerant',
    '--no-write',
  ]);
  assert.equal(tolerantRun.status, 0, tolerantRun.stderr);
  assert.match(tolerantRun.stdout, /failures=0/);
  assert.match(tolerantRun.stdout, /tolerant_python_kwarg_reorder: 1/);
});

test('bulk analyzer prints suite breakdown for core vs pat rows', async () => {
  const workspaceFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-autocomplete-analyze-'));
  const artifactDir = path.join(workspaceFolder, 'test_artifacts');
  await fs.mkdir(artifactDir, { recursive: true });
  const csvPath = path.join(artifactDir, 'autocomplete_test_output_20260228_190300.csv');
  await fs.writeFile(
    csvPath,
    [
      'test,target_output,context,output',
      '"TS-CORE-1 TypeScript | file=test_files/typescript/simple_autocomplete.ts","normalized);","{}","normalized);"',
      '"PAT-TS-1 Pattern | file=test_files/typescript/patterns_autocomplete.ts",")","{}",")"',
    ].join('\n'),
    'utf8',
  );

  const strictRun = runAnalyzer([
    '--workspace',
    workspaceFolder,
    '--file',
    csvPath,
    '--mode',
    'strict',
    '--no-write',
  ]);
  assert.equal(strictRun.status, 0, strictRun.stderr);
  assert.match(strictRun.stdout, /suite_breakdown:/);
  assert.match(strictRun.stdout, /suite=core total_rows=1/);
  assert.match(strictRun.stdout, /suite=pat total_rows=1/);
});

test('bulk analyzer exits non-zero when --fail-on-mismatch is set and failures exist', async () => {
  const workspaceFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-autocomplete-analyze-'));
  const artifactDir = path.join(workspaceFolder, 'test_artifacts');
  await fs.mkdir(artifactDir, { recursive: true });
  const csvPath = path.join(artifactDir, 'autocomplete_test_output_20260228_190325.csv');
  await fs.writeFile(
    csvPath,
    [
      'test,target_output,context,output',
      '"TS-FAIL-1 | file=test_files/typescript/simple_autocomplete.ts","normalized);","{}","other);"',
    ].join('\n'),
    'utf8',
  );

  const strictFailRun = runAnalyzer([
    '--workspace',
    workspaceFolder,
    '--file',
    csvPath,
    '--mode',
    'strict',
    '--no-write',
    '--fail-on-mismatch',
  ]);
  assert.equal(strictFailRun.status, 2, strictFailRun.stderr);
  assert.match(strictFailRun.stdout, /mode=strict/);
  assert.match(strictFailRun.stdout, /failures=1/);
});

test('bulk analyzer exits non-zero when --fail-on-empty-output is set and empty outputs exist', async () => {
  const workspaceFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-autocomplete-analyze-'));
  const artifactDir = path.join(workspaceFolder, 'test_artifacts');
  await fs.mkdir(artifactDir, { recursive: true });
  const csvPath = path.join(artifactDir, 'autocomplete_test_output_20260228_190330.csv');
  await fs.writeFile(
    csvPath,
    [
      'test,target_output,context,output',
      '"PY-EMPTY-1 | file=test_files/python/simple_autocomplete.py","name)","{}",""',
    ].join('\n'),
    'utf8',
  );

  const run = runAnalyzer([
    '--workspace',
    workspaceFolder,
    '--file',
    csvPath,
    '--mode',
    'strict',
    '--no-write',
    '--fail-on-empty-output',
  ]);
  assert.equal(run.status, 3, run.stderr);
  assert.match(run.stdout, /mode=strict/);
  assert.match(run.stdout, /empty_outputs=1/);
});

test('bulk analyzer keeps zero exit with --fail-on-empty-output when no empty outputs exist', async () => {
  const workspaceFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-autocomplete-analyze-'));
  const artifactDir = path.join(workspaceFolder, 'test_artifacts');
  await fs.mkdir(artifactDir, { recursive: true });
  const csvPath = path.join(artifactDir, 'autocomplete_test_output_20260228_190331.csv');
  await fs.writeFile(
    csvPath,
    [
      'test,target_output,context,output',
      '"PY-NONEMPTY-1 | file=test_files/python/simple_autocomplete.py","name)","{}","name)"',
    ].join('\n'),
    'utf8',
  );

  const run = runAnalyzer([
    '--workspace',
    workspaceFolder,
    '--file',
    csvPath,
    '--mode',
    'strict',
    '--no-write',
    '--fail-on-empty-output',
  ]);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /mode=strict/);
  assert.match(run.stdout, /empty_outputs=0/);
});

test('bulk analyzer filters rows with --test-pattern', async () => {
  const workspaceFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-autocomplete-analyze-'));
  const artifactDir = path.join(workspaceFolder, 'test_artifacts');
  await fs.mkdir(artifactDir, { recursive: true });
  const csvPath = path.join(artifactDir, 'autocomplete_test_output_20260228_190350.csv');
  await fs.writeFile(
    csvPath,
    [
      'test,target_output,context,output',
      '"ADV-PY-4 Return variable suffix | file=test_files/python/advanced_autocomplete.py"," first","{}"," first"',
      '"PY-1 Simple autocomplete | file=test_files/python/simple_autocomplete.py","""Mina"")","{}","""Mina"")"',
    ].join('\n'),
    'utf8',
  );

  const run = runAnalyzer([
    '--workspace',
    workspaceFolder,
    '--file',
    csvPath,
    '--mode',
    'strict',
    '--no-write',
    '--test-pattern',
    'ADV-PY-4',
  ]);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /test_pattern=contains\("ADV-PY-4"\)/);
  assert.match(run.stdout, /test_pattern_rows=1\/2/);
  assert.match(run.stdout, /total_rows=1/);
  assert.match(run.stdout, /exact_matches=1/);
});

test('bulk analyzer fails with invalid --test-pattern regex', async () => {
  const workspaceFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-autocomplete-analyze-'));
  const artifactDir = path.join(workspaceFolder, 'test_artifacts');
  await fs.mkdir(artifactDir, { recursive: true });
  const csvPath = path.join(artifactDir, 'autocomplete_test_output_20260228_190360.csv');
  await fs.writeFile(
    csvPath,
    [
      'test,target_output,context,output',
      '"ADV-PY-4 Return variable suffix"," first","{}"," first"',
    ].join('\n'),
    'utf8',
  );

  const run = runAnalyzer([
    '--workspace',
    workspaceFolder,
    '--file',
    csvPath,
    '--mode',
    'strict',
    '--no-write',
    '--test-pattern',
    '/[abc/',
  ]);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Invalid --test-pattern/);
});
