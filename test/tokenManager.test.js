require('./helpers/registerVscode.js');

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TokenManager,
  NotAuthenticatedError,
} = require('../out/auth/tokenManager.js');

class MemorySecretStorage {
  constructor() {
    this.storeMap = new Map();
  }

  get(key) {
    return Promise.resolve(this.storeMap.get(key));
  }

  store(key, value) {
    this.storeMap.set(key, value);
    return Promise.resolve();
  }

  delete(key) {
    this.storeMap.delete(key);
    return Promise.resolve();
  }
}

test('TokenManager returns stored access token when not expired', async () => {
  const storage = new MemorySecretStorage();
  const manager = new TokenManager(storage);

  await manager.saveTokens({ accessToken: 'access-1', expiresIn: 3600 });
  const token = await manager.getAccessToken();

  assert.equal(token, 'access-1');
});

test('TokenManager throws when not authenticated', async () => {
  const storage = new MemorySecretStorage();
  const manager = new TokenManager(storage);

  await assert.rejects(() => manager.getAccessToken(), NotAuthenticatedError);
});

test('TokenManager reports token presence', async () => {
  const storage = new MemorySecretStorage();
  const manager = new TokenManager(storage);

  assert.equal(await manager.hasToken(), false);
  await manager.saveTokens({ accessToken: 'access-1', expiresIn: 3600 });
  assert.equal(await manager.hasToken(), true);
  await manager.clearTokens();
  assert.equal(await manager.hasToken(), false);
});

test('Expired token without refresh forces re-login path', async () => {
  const storage = new MemorySecretStorage();
  const manager = new TokenManager(storage);

  await manager.saveTokens({ accessToken: 'access-1', expiresIn: -1 });

  await assert.rejects(() => manager.getAccessToken(), NotAuthenticatedError);
  assert.equal(await storage.get('tabAutocomplete.tokens'), undefined);
});

test('Concurrent refresh requests share a single refresh call', async () => {
  const storage = new MemorySecretStorage();
  const manager = new TokenManager(storage);
  await manager.saveTokens({ accessToken: 'expired-token', refreshToken: 'refresh-1', expiresIn: -1 });

  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return {
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'new-access', refresh_token: 'refresh-2', expires_in: 3600 }),
    };
  };

  try {
    const [a, b] = await Promise.all([manager.getAccessToken(), manager.getAccessToken()]);
    assert.equal(a, 'new-access');
    assert.equal(b, 'new-access');
    assert.equal(calls, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Logout clears tokens and attempts token revocation', async () => {
  const storage = new MemorySecretStorage();
  const manager = new TokenManager(storage);
  await manager.saveTokens({ accessToken: 'access-a', refreshToken: 'refresh-a', expiresIn: 3600 });

  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (_url, init) => {
    calls.push(init.body.toString());
    return { ok: true, status: 200 };
  };

  try {
    await manager.logout();
    assert.equal(await storage.get('tabAutocomplete.tokens'), undefined);
    assert.equal(calls.length, 2);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Logout during refresh does not restore tokens', async () => {
  const storage = new MemorySecretStorage();
  const manager = new TokenManager(storage);
  await manager.saveTokens({ accessToken: 'expired-token', refreshToken: 'refresh-1', expiresIn: -1 });

  const refreshBarrier = {};
  refreshBarrier.promise = new Promise((resolve) => {
    refreshBarrier.resolve = resolve;
  });

  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('/oauth/token')) {
      await refreshBarrier.promise;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'restored-access',
          refresh_token: 'restored-refresh',
          expires_in: 3600,
        }),
      };
    }

    return { ok: true, status: 200 };
  };

  try {
    const pendingAccessToken = manager.getAccessToken();
    await new Promise((resolve) => setTimeout(resolve, 0));

    await manager.logout();
    refreshBarrier.resolve();

    await assert.rejects(() => pendingAccessToken, NotAuthenticatedError);
    assert.equal(await storage.get('tabAutocomplete.tokens'), undefined);
  } finally {
    global.fetch = originalFetch;
  }
});

test('TokenManager identifies API key tokens', async () => {
  const storage = new MemorySecretStorage();
  const manager = new TokenManager(storage);

  await manager.saveTokens({ accessToken: 'sk-test-key', expiresIn: 3600 });
  const hint = await manager.getTokenTypeHint();

  assert.equal(hint, 'apiKey');
});

test('TokenManager identifies OAuth tokens', async () => {
  const storage = new MemorySecretStorage();
  const manager = new TokenManager(storage);

  await manager.saveTokens({ accessToken: 'a.b.c', expiresIn: 3600 });
  const hint = await manager.getTokenTypeHint();

  assert.equal(hint, 'oauth');
});

test('TokenManager returns unknown for unrecognized token formats', async () => {
  const storage = new MemorySecretStorage();
  const manager = new TokenManager(storage);

  await manager.saveTokens({ accessToken: 'not-a-jwt', expiresIn: 3600 });
  const hint = await manager.getTokenTypeHint();

  assert.equal(hint, 'unknown');
});
