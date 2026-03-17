require('./helpers/registerVscode.js');

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildAuthorizationUrl } = require('../out/auth/oauth.js');

test('OAuth authorization URL includes required OpenAI login parameters', () => {
  const url = buildAuthorizationUrl(
    'challenge-123',
    'state-456',
    'http://localhost:1455/auth/callback',
  );
  const parsed = new URL(url);

  assert.equal(parsed.origin + parsed.pathname, 'https://auth.openai.com/oauth/authorize');
  assert.equal(parsed.searchParams.get('client_id'), 'app_EMoamEEZ73f0CkXaXp7hrann');
  assert.equal(parsed.searchParams.get('scope'), 'openid profile email offline_access');
  assert.equal(parsed.searchParams.get('response_type'), 'code');
  assert.equal(parsed.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(parsed.searchParams.get('code_challenge'), 'challenge-123');
  assert.equal(parsed.searchParams.get('id_token_add_organizations'), 'true');
  assert.equal(parsed.searchParams.get('codex_cli_simplified_flow'), 'true');
  assert.equal(parsed.searchParams.get('originator'), 'codex_vscode');
  assert.equal(parsed.searchParams.get('state'), 'state-456');
  assert.equal(parsed.searchParams.get('redirect_uri'), 'http://localhost:1455/auth/callback');
});
