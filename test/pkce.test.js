const test = require('node:test');
const assert = require('node:assert/strict');

const { createVerifier, createChallenge, createState } = require('../out/auth/pkce.js');

test('PKCE helper generates URL-safe verifier and state', () => {
  const verifier = createVerifier();
  const state = createState();

  assert.match(verifier, /^[A-Za-z0-9_-]+$/);
  assert.match(state, /^[A-Za-z0-9_-]+$/);
  assert.ok(verifier.length >= 43);
  assert.ok(state.length >= 16);
});

test('PKCE challenge is deterministic for a verifier', async () => {
  const challenge = await createChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk');
  assert.equal(challenge, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});
