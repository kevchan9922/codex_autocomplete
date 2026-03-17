const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  parseArgs,
  parseInteger,
  normalizeBenchmarkMode,
  assertNoRemovedHotkeyBenchmarkArgs,
  resolveRateLimitConfig,
  inferLanguageId,
  resolveEndpoint,
  resolveAuthToken,
  resolveInputFilePath,
  buildContextStringFromText,
} = require('../scripts/run-response-time-test.js');

test('response-time CLI helpers parse args and endpoint resolution correctly', () => {
  const args = parseArgs([
    '--workspace',
    '/tmp/repo',
    '--model=gpt-5.4',
    '--max-output-tokens',
    '128',
    '--help',
  ]);

  assert.equal(args.workspace, '/tmp/repo');
  assert.equal(args.model, 'gpt-5.4');
  assert.equal(args['max-output-tokens'], '128');
  assert.equal(args.help, 'true');
  assert.equal(parseInteger(args['max-output-tokens'], 'max-output-tokens'), 128);
  assert.equal(resolveEndpoint('sk-test-token', undefined), 'https://api.openai.com/v1/responses');
  assert.equal(
    resolveEndpoint('oauth-token', undefined),
    'https://chatgpt.com/backend-api/codex/responses',
  );
  assert.equal(
    resolveInputFilePath('/tmp/repo', undefined),
    '/tmp/repo/test_files/response_time_test_input.json',
  );
  assert.equal(
    resolveInputFilePath('/tmp/repo', 'test_files/custom_input.json'),
    '/tmp/repo/test_files/custom_input.json',
  );
  assert.equal(normalizeBenchmarkMode(undefined), 'hotkey_inline');
  assert.equal(normalizeBenchmarkMode('automatic_direct'), 'automatic_direct');
  assert.equal(normalizeBenchmarkMode('hotkey_inline'), 'hotkey_inline');
  assert.throws(
    () => normalizeBenchmarkMode('unknown-mode'),
    /Expected "hotkey_inline" or "automatic_direct"/,
  );
  assert.throws(
    () => assertNoRemovedHotkeyBenchmarkArgs({ 'hotkey-fast-stage-max-latency-ms': '500' }),
    /use built-in hotkey defaults/,
  );
  assert.deepEqual(resolveRateLimitConfig({}), {
    rateLimitWindowSec: 1,
    rateLimitMaxRequests: 1000,
  });
  assert.deepEqual(resolveRateLimitConfig({
    'rate-limit-window-sec': '7',
    'rate-limit-max-requests': '9',
  }), {
    rateLimitWindowSec: 7,
    rateLimitMaxRequests: 9,
  });
});

test('response-time CLI infers language and builds non-skip context JSON', () => {
  assert.equal(inferLanguageId('/tmp/manual_test.py'), 'python');
  assert.equal(inferLanguageId('/tmp/manual_test.ts'), 'typescript');
  assert.equal(inferLanguageId('/tmp/manual_test.unknown'), 'plaintext');

  const contextJson = buildContextStringFromText({
    text: 'def greet(name: str) -> str:\n    return name.upper()\n',
    filePath: '/tmp/manual_test.py',
    languageId: 'python',
    cursorLineOneBased: 2,
    cursorCharOneBased: 10,
    maxContextLines: 60,
    maxFileLines: 5000,
  });
  const parsed = JSON.parse(contextJson);
  assert.equal(parsed.skipped, undefined);
  assert.equal(typeof parsed.prefix, 'string');
  assert.equal(typeof parsed.suffix, 'string');
});

test('response-time CLI falls back to test/artifacts/oauth_test_token.txt when TAB_AUTOCOMPLETE_BEARER_TOKEN is blank', async () => {
  const workspaceFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-token-'));
  const artifactDir = path.join(workspaceFolder, 'test', 'artifacts');
  await fs.mkdir(artifactDir, { recursive: true });
  await fs.writeFile(path.join(artifactDir, 'oauth_test_token.txt'), '  file-token  \n', 'utf8');

  const previousBearer = process.env.TAB_AUTOCOMPLETE_BEARER_TOKEN;
  const previousApiKey = process.env.OPENAI_API_KEY;
  process.env.TAB_AUTOCOMPLETE_BEARER_TOKEN = '   ';
  process.env.OPENAI_API_KEY = '';

  try {
    const token = await resolveAuthToken(workspaceFolder, undefined);
    assert.equal(token, 'file-token');
  } finally {
    if (previousBearer === undefined) {
      delete process.env.TAB_AUTOCOMPLETE_BEARER_TOKEN;
    } else {
      process.env.TAB_AUTOCOMPLETE_BEARER_TOKEN = previousBearer;
    }
    if (previousApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousApiKey;
    }
    await fs.rm(workspaceFolder, { recursive: true, force: true });
  }
});
