const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  parseArgs,
  parseInteger,
  parseBooleanFlag,
  parseBenchmarkMode,
  assertNoRemovedHotkeyBenchmarkArgs,
  resolveRateLimitConfig,
  inferLanguageId,
  resolveEndpoint,
  resolveAuthToken,
} = require('../scripts/run-bulk-autocomplete-test.js');

test('bulk CLI helpers parse benchmark settings', () => {
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
  assert.equal(parseBooleanFlag(args.help), true);
  assert.equal(parseBenchmarkMode(undefined), 'hotkey_inline');
  assert.equal(parseBenchmarkMode('direct'), 'direct');
  assert.equal(parseBenchmarkMode('hotkey_inline'), 'hotkey_inline');
  assert.throws(
    () => assertNoRemovedHotkeyBenchmarkArgs({ 'hotkey-fast-stage-max-latency-ms': '500' }),
    /use built-in hotkey defaults/,
  );
  assert.deepEqual(resolveRateLimitConfig({}), {
    rateLimitWindowSec: 1,
    rateLimitMaxRequests: 1000,
  });
  assert.deepEqual(resolveRateLimitConfig({
    'rate-limit-window-sec': '3',
    'rate-limit-max-requests': '11',
  }), {
    rateLimitWindowSec: 3,
    rateLimitMaxRequests: 11,
  });
  assert.equal(inferLanguageId('/tmp/manual_test.py'), 'python');
  assert.equal(resolveEndpoint('sk-test-token', undefined), 'https://api.openai.com/v1/responses');
  assert.equal(
    resolveEndpoint('oauth-token', undefined),
    'https://chatgpt.com/backend-api/codex/responses',
  );
});

test('bulk CLI falls back to test/artifacts/oauth_test_token.txt when TAB_AUTOCOMPLETE_BEARER_TOKEN is blank', async () => {
  const workspaceFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-bulk-token-'));
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
