const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function runCompare(args) {
  return spawnSync(
    process.execPath,
    [path.join(process.cwd(), 'scripts', 'compare-response-time-history.js'), ...args],
    { encoding: 'utf8' },
  );
}

test('response-time compare prints insufficient-runs message when history has < 2 runs', async () => {
  const workspaceFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-autocomplete-rt-compare-'));
  const artifactDir = path.join(workspaceFolder, 'test_artifacts');
  await fs.mkdir(artifactDir, { recursive: true });
  const historyPath = path.join(artifactDir, 'response_time_history.csv');
  await fs.writeFile(
    historyPath,
    [
      'run_id,run_started_at,test,target_output,first_chunk_ms,total_duration_ms,status,match_target_output,output_length,language_id,file_path,model,endpoint',
      '20260301_000000,2026-03-01T00:00:00.000Z,PY-1,"""Mina"")",n/a,1,error,false,22,python,/tmp/manual_test.py,gpt-5.4,https://chatgpt.com/backend-api/codex/responses',
    ].join('\n'),
    'utf8',
  );

  const result = runCompare(['--workspace', workspaceFolder]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /runs_detected=1/);
  assert.match(result.stdout, /comparable_runs_detected=0/);
  assert.match(result.stdout, /latest_overall_run=20260301_000000/);
  assert.match(result.stdout, /latest_overall_status=success:0 empty:0 error:1 match:0\/1/);
  assert.match(result.stdout, /insufficient_comparable_runs=0 need_at_least=2/);
  assert.match(result.stdout, /compare_hint=record at least two runs with status=success and numeric first_chunk_ms/);
});

test('response-time compare reports latest vs previous run deltas', async () => {
  const workspaceFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-autocomplete-rt-compare-'));
  const artifactDir = path.join(workspaceFolder, 'test_artifacts');
  await fs.mkdir(artifactDir, { recursive: true });
  const historyPath = path.join(artifactDir, 'response_time_history.csv');
  await fs.writeFile(
    historyPath,
    [
      'run_id,run_started_at,test,target_output,first_chunk_ms,total_duration_ms,status,match_target_output,output_length,language_id,file_path,model,endpoint',
      '20260301_000000,2026-03-01T00:00:00.000Z,PY-1,"""Mina"")",100,300,success,true,7,python,/tmp/manual_test.py,gpt-5.4,https://chatgpt.com/backend-api/codex/responses',
      '20260301_000000,2026-03-01T00:00:00.000Z,PY-2,n/a,n/a,500,error,false,0,python,/tmp/manual_test.py,gpt-5.4,https://chatgpt.com/backend-api/codex/responses',
      '20260302_000000,2026-03-02T00:00:00.000Z,PY-1,"""Mina"")",80,280,success,true,7,python,/tmp/manual_test.py,gpt-5.4,https://chatgpt.com/backend-api/codex/responses',
      '20260302_000000,2026-03-02T00:00:00.000Z,PY-2,n/a,90,400,success,false,0,python,/tmp/manual_test.py,gpt-5.4,https://chatgpt.com/backend-api/codex/responses',
    ].join('\n'),
    'utf8',
  );

  const result = runCompare(['--workspace', workspaceFolder]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /previous_run=20260301_000000/);
  assert.match(result.stdout, /latest_run=20260302_000000/);
  assert.match(result.stdout, /dataset_mismatch=false/);
  assert.match(result.stdout, /delta_first_chunk_avg_ms=-15/);
  assert.match(result.stdout, /delta_total_duration_avg_ms=\+?40/);
  assert.match(result.stdout, /delta_success_rate_pp=\+?50/);
  assert.doesNotMatch(result.stdout, /per_test_comparison_rows=/);
  assert.doesNotMatch(result.stdout, /top_first_chunk_regressions_count=/);
  assert.doesNotMatch(result.stdout, /top_latest_first_chunk_count=/);
});

test('response-time compare skips latest error-only run and compares latest comparable runs', async () => {
  const workspaceFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-autocomplete-rt-compare-'));
  const artifactDir = path.join(workspaceFolder, 'test_artifacts');
  await fs.mkdir(artifactDir, { recursive: true });
  const historyPath = path.join(artifactDir, 'response_time_history.csv');
  await fs.writeFile(
    historyPath,
    [
      'run_id,run_started_at,test,target_output,first_chunk_ms,total_duration_ms,status,match_target_output,output_length,language_id,file_path,model,endpoint',
      '20260301_000000,2026-03-01T00:00:00.000Z,PY-1,"""Mina"")",120,320,success,true,7,python,/tmp/manual_test.py,gpt-5.4,https://chatgpt.com/backend-api/codex/responses',
      '20260302_000000,2026-03-02T00:00:00.000Z,PY-1,"""Mina"")",100,300,success,true,7,python,/tmp/manual_test.py,gpt-5.4,https://chatgpt.com/backend-api/codex/responses',
      '20260303_000000,2026-03-03T00:00:00.000Z,PY-1,"""Mina"")",n/a,1,error,false,0,python,/tmp/manual_test.py,gpt-5.4,https://chatgpt.com/backend-api/codex/responses',
    ].join('\n'),
    'utf8',
  );

  const result = runCompare(['--workspace', workspaceFolder]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /runs_detected=3/);
  assert.match(result.stdout, /comparable_runs_detected=2/);
  assert.match(result.stdout, /latest_overall_run=20260303_000000/);
  assert.match(
    result.stdout,
    /latest_overall_run_skipped=20260303_000000 reason=no_comparable_latency_rows/,
  );
  assert.match(result.stdout, /previous_run=20260301_000000/);
  assert.match(result.stdout, /latest_run=20260302_000000/);
  assert.match(result.stdout, /delta_first_chunk_avg_ms=-20/);
  assert.match(result.stdout, /delta_total_duration_avg_ms=-20/);
});

test('response-time compare warns when compared runs use different datasets', async () => {
  const workspaceFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-autocomplete-rt-compare-'));
  const artifactDir = path.join(workspaceFolder, 'test_artifacts');
  await fs.mkdir(artifactDir, { recursive: true });
  const historyPath = path.join(artifactDir, 'response_time_history.csv');
  await fs.writeFile(
    historyPath,
    [
      'run_id,run_started_at,test,target_output,first_chunk_ms,total_duration_ms,status,match_target_output,output_length,language_id,file_path,model,endpoint',
      '20260301_000000,2026-03-01T00:00:00.000Z,PY-1,A,100,300,success,true,1,python,/tmp/manual_test.py,gpt-5.4,https://chatgpt.com/backend-api/codex/responses',
      '20260301_000000,2026-03-01T00:00:00.000Z,PY-2,B,90,280,success,true,1,python,/tmp/manual_test.py,gpt-5.4,https://chatgpt.com/backend-api/codex/responses',
      '20260302_000000,2026-03-02T00:00:00.000Z,PY-1,A,80,260,success,true,1,python,/tmp/manual_test.py,gpt-5.4,https://chatgpt.com/backend-api/codex/responses',
    ].join('\n'),
    'utf8',
  );

  const result = runCompare(['--workspace', workspaceFolder]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /dataset_mismatch=true/);
  assert.match(result.stdout, /dataset_previous_only=1/);
  assert.match(result.stdout, /dataset_latest_only=0/);
  assert.match(result.stdout, /dataset_mismatch_mode=warn/);
  assert.match(result.stdout, /delta_first_chunk_avg_ms=-15/);
});

test('response-time compare fails with --fail-on-dataset-mismatch when datasets differ', async () => {
  const workspaceFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-autocomplete-rt-compare-'));
  const artifactDir = path.join(workspaceFolder, 'test_artifacts');
  await fs.mkdir(artifactDir, { recursive: true });
  const historyPath = path.join(artifactDir, 'response_time_history.csv');
  await fs.writeFile(
    historyPath,
    [
      'run_id,run_started_at,test,target_output,first_chunk_ms,total_duration_ms,status,match_target_output,output_length,language_id,file_path,model,endpoint',
      '20260301_000000,2026-03-01T00:00:00.000Z,PY-1,A,100,300,success,true,1,python,/tmp/manual_test.py,gpt-5.4,https://chatgpt.com/backend-api/codex/responses',
      '20260301_000000,2026-03-01T00:00:00.000Z,PY-2,B,90,280,success,true,1,python,/tmp/manual_test.py,gpt-5.4,https://chatgpt.com/backend-api/codex/responses',
      '20260302_000000,2026-03-02T00:00:00.000Z,PY-1,A,80,260,success,true,1,python,/tmp/manual_test.py,gpt-5.4,https://chatgpt.com/backend-api/codex/responses',
    ].join('\n'),
    'utf8',
  );

  const result = runCompare(['--workspace', workspaceFolder, '--fail-on-dataset-mismatch']);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stdout, /dataset_mismatch=true/);
  assert.match(result.stdout, /dataset_mismatch_mode=fail/);
});

test('response-time compare warns when compared runs use different endpoint/model/mode parity', async () => {
  const workspaceFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-autocomplete-rt-compare-'));
  const artifactDir = path.join(workspaceFolder, 'test_artifacts');
  await fs.mkdir(artifactDir, { recursive: true });
  const historyPath = path.join(artifactDir, 'response_time_history.csv');
  await fs.writeFile(
    historyPath,
    [
      'run_id,run_started_at,test,target_output,first_chunk_ms,total_duration_ms,status,match_target_output,output_length,language_id,file_path,model,endpoint,context_char_count,instructions_char_count,input_chars_est,input_tokens_est,benchmark_mode',
      '20260301_000000,2026-03-01T00:00:00.000Z,PY-1,A,100,300,success,true,1,python,/tmp/manual_test.py,gpt-5.4,https://chatgpt.com/backend-api/codex/responses,0,300,1000,250,automatic_direct',
      '20260302_000000,2026-03-02T00:00:00.000Z,PY-1,A,80,260,success,true,1,python,/tmp/manual_test.py,gpt-5.4,https://api.openai.com/v1/responses,0,300,1000,250,hotkey_inline',
    ].join('\n'),
    'utf8',
  );

  const result = runCompare(['--workspace', workspaceFolder]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /dataset_mismatch=false/);
  assert.match(result.stdout, /parity_mismatch=true/);
  assert.match(result.stdout, /parity_previous_endpoint=https:\/\/chatgpt\.com\/backend-api\/codex\/responses/);
  assert.match(result.stdout, /parity_latest_endpoint=https:\/\/api\.openai\.com\/v1\/responses/);
  assert.match(result.stdout, /parity_previous_benchmark_mode=automatic_direct/);
  assert.match(result.stdout, /parity_latest_benchmark_mode=hotkey_inline/);
  assert.match(result.stdout, /parity_mismatch_mode=warn/);
});

test('response-time compare fails with --fail-on-parity-mismatch when compared runs differ in parity fields', async () => {
  const workspaceFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-autocomplete-rt-compare-'));
  const artifactDir = path.join(workspaceFolder, 'test_artifacts');
  await fs.mkdir(artifactDir, { recursive: true });
  const historyPath = path.join(artifactDir, 'response_time_history.csv');
  await fs.writeFile(
    historyPath,
    [
      'run_id,run_started_at,test,target_output,first_chunk_ms,total_duration_ms,status,match_target_output,output_length,language_id,file_path,model,endpoint,context_char_count,instructions_char_count,input_chars_est,input_tokens_est,benchmark_mode',
      '20260301_000000,2026-03-01T00:00:00.000Z,PY-1,A,100,300,success,true,1,python,/tmp/manual_test.py,gpt-5.4,https://chatgpt.com/backend-api/codex/responses,0,300,1000,250,automatic_direct',
      '20260302_000000,2026-03-02T00:00:00.000Z,PY-1,A,80,260,success,true,1,python,/tmp/manual_test.py,gpt-5.4,https://api.openai.com/v1/responses,0,300,1000,250,hotkey_inline',
    ].join('\n'),
    'utf8',
  );

  const result = runCompare(['--workspace', workspaceFolder, '--fail-on-parity-mismatch']);
  assert.equal(result.status, 3, result.stderr);
  assert.match(result.stdout, /parity_mismatch=true/);
  assert.match(result.stdout, /parity_mismatch_mode=fail/);
});

test('response-time compare filters history rows with --test-pattern', async () => {
  const workspaceFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-autocomplete-rt-compare-'));
  const artifactDir = path.join(workspaceFolder, 'test_artifacts');
  await fs.mkdir(artifactDir, { recursive: true });
  const historyPath = path.join(artifactDir, 'response_time_history.csv');
  await fs.writeFile(
    historyPath,
    [
      'run_id,run_started_at,test,target_output,first_chunk_ms,total_duration_ms,status,match_target_output,output_length,language_id,file_path,model,endpoint',
      '20260301_000000,2026-03-01T00:00:00.000Z,ADV-PY-4 Return variable suffix, first,120,300,success,true,6,python,/tmp/advanced_autocomplete.py,gpt-5.4,https://chatgpt.com/backend-api/codex/responses',
      '20260301_000000,2026-03-01T00:00:00.000Z,PY-1 Simple autocomplete,"""Mina"")",200,380,success,true,7,python,/tmp/simple_autocomplete.py,gpt-5.4,https://chatgpt.com/backend-api/codex/responses',
      '20260302_000000,2026-03-02T00:00:00.000Z,ADV-PY-4 Return variable suffix, first,90,260,success,false,0,python,/tmp/advanced_autocomplete.py,gpt-5.4,https://chatgpt.com/backend-api/codex/responses',
      '20260302_000000,2026-03-02T00:00:00.000Z,PY-1 Simple autocomplete,"""Mina"")",170,340,success,true,7,python,/tmp/simple_autocomplete.py,gpt-5.4,https://chatgpt.com/backend-api/codex/responses',
    ].join('\n'),
    'utf8',
  );

  const result = runCompare(['--workspace', workspaceFolder, '--test-pattern', 'ADV-PY-4']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /test_pattern=contains\("ADV-PY-4"\)/);
  assert.match(result.stdout, /test_pattern_rows=2\/4/);
  assert.match(result.stdout, /previous_dataset_tests=1/);
  assert.match(result.stdout, /latest_dataset_tests=1/);
  assert.doesNotMatch(result.stdout, /per_test_comparison_rows=/);
  assert.doesNotMatch(result.stdout, /test:ADV-PY-4 Return variable suffix/);
  assert.doesNotMatch(result.stdout, /test:PY-1 Simple autocomplete/);
});

test('response-time compare excludes scenario-dependent rows from exact-match scoring', async () => {
  const workspaceFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-autocomplete-rt-compare-'));
  const artifactDir = path.join(workspaceFolder, 'test_artifacts');
  await fs.mkdir(artifactDir, { recursive: true });
  const historyPath = path.join(artifactDir, 'response_time_history.csv');
  await fs.writeFile(
    historyPath,
    [
      'run_id,run_started_at,test,target_output,first_chunk_ms,total_duration_ms,status,match_target_output,output_length,language_id,file_path,model,endpoint',
      '20260301_000000,2026-03-01T00:00:00.000Z,PY-1,A,100,300,success,true,1,python,/tmp/manual_test.py,gpt-5.4,https://chatgpt.com/backend-api/codex/responses',
      '20260301_000000,2026-03-01T00:00:00.000Z,Boundary-1 Python large file,<scenario-dependent>,110,320,success,,4,python,/tmp/manual_test.py,gpt-5.4,https://chatgpt.com/backend-api/codex/responses',
      '20260302_000000,2026-03-02T00:00:00.000Z,PY-1,A,80,260,success,true,1,python,/tmp/manual_test.py,gpt-5.4,https://chatgpt.com/backend-api/codex/responses',
      '20260302_000000,2026-03-02T00:00:00.000Z,Boundary-1 Python large file,<scenario-dependent>,90,250,success,,4,python,/tmp/manual_test.py,gpt-5.4,https://chatgpt.com/backend-api/codex/responses',
    ].join('\n'),
    'utf8',
  );

  const result = runCompare(['--workspace', workspaceFolder]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /latest_overall_status=success:2 empty:0 error:0 match:1\/1 non_scored:1/);
  assert.match(result.stdout, /previous_status=success:2 empty:0 error:0 match:1\/1 non_scored:1/);
  assert.match(result.stdout, /latest_status=success:2 empty:0 error:0 match:1\/1 non_scored:1/);
});

test('response-time compare fails with invalid --test-pattern regex', async () => {
  const workspaceFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-autocomplete-rt-compare-'));
  const artifactDir = path.join(workspaceFolder, 'test_artifacts');
  await fs.mkdir(artifactDir, { recursive: true });
  const historyPath = path.join(artifactDir, 'response_time_history.csv');
  await fs.writeFile(
    historyPath,
    [
      'run_id,run_started_at,test,target_output,first_chunk_ms,total_duration_ms,status,match_target_output,output_length,language_id,file_path,model,endpoint',
      '20260301_000000,2026-03-01T00:00:00.000Z,ADV-PY-4 Return variable suffix, first,120,300,success,true,6,python,/tmp/advanced_autocomplete.py,gpt-5.4,https://chatgpt.com/backend-api/codex/responses',
      '20260302_000000,2026-03-02T00:00:00.000Z,ADV-PY-4 Return variable suffix, first,90,260,success,false,0,python,/tmp/advanced_autocomplete.py,gpt-5.4,https://chatgpt.com/backend-api/codex/responses',
    ].join('\n'),
    'utf8',
  );

  const result = runCompare(['--workspace', workspaceFolder, '--test-pattern', '/[abc/']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid --test-pattern/);
});
