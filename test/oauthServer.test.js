const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { startOAuthCallbackServer } = require('../out/auth/oauthServer.js');

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function ensureCanListen(t) {
  const probe = http.createServer((_req, res) => res.end('ok'));
  try {
    await listen(probe, 0, '127.0.0.1');
    await close(probe);
    return true;
  } catch (error) {
    await close(probe);
    if (error && error.code === 'EPERM') {
      t.skip('Network listen not permitted in this environment.');
      return false;
    }
    throw error;
  }
}

test('oauth server returns code and state from callback', async (t) => {
  if (!(await ensureCanListen(t))) {
    return;
  }

  const server = await startOAuthCallbackServer({ host: '127.0.0.1', port: 1567, timeoutMs: 2000 });
  try {
    const waitPromise = server.waitForCallback();
    const response = await fetch(`${server.redirectUri}?code=abc&state=xyz`);
    assert.equal(response.status, 200);

    const callback = await waitPromise;
    assert.deepEqual(callback, { code: 'abc', state: 'xyz' });
  } finally {
    server.dispose();
  }
});

test('oauth server falls back to next port when requested port is in use', async (t) => {
  if (!(await ensureCanListen(t))) {
    return;
  }

  const occupied = http.createServer((_req, res) => res.end('busy'));
  await listen(occupied, 1666, '127.0.0.1');

  const server = await startOAuthCallbackServer({
    host: '127.0.0.1',
    port: 1666,
    portFallbackCount: 1,
    timeoutMs: 2000,
  });

  try {
    assert.ok(server.redirectUri.includes(':1667/'), `unexpected redirect uri: ${server.redirectUri}`);
    const waitPromise = server.waitForCallback();
    const response = await fetch(`${server.redirectUri}?code=abc&state=xyz`);
    assert.equal(response.status, 200);
    await waitPromise;
  } finally {
    server.dispose();
    await close(occupied);
  }
});

test('oauth server times out when no callback received', async (t) => {
  if (!(await ensureCanListen(t))) {
    return;
  }

  const server = await startOAuthCallbackServer({ host: '127.0.0.1', port: 1670, timeoutMs: 10 });
  try {
    await assert.rejects(() => server.waitForCallback(), /timed out/i);
  } finally {
    server.dispose();
  }
});
