#!/usr/bin/env node
'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const AUTH_BASE_URL = 'https://auth.openai.com/oauth/authorize';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const SCOPE = 'openid profile email offline_access';
const ORIGINATOR = 'codex_vscode';
const CALLBACK_PATH = '/auth/callback';

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      continue;
    }

    const withoutPrefix = token.slice(2);
    const equalIndex = withoutPrefix.indexOf('=');
    if (equalIndex >= 0) {
      const key = withoutPrefix.slice(0, equalIndex);
      const value = withoutPrefix.slice(equalIndex + 1);
      args[key] = value;
      continue;
    }

    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      args[withoutPrefix] = next;
      index += 1;
      continue;
    }

    args[withoutPrefix] = 'true';
  }
  return args;
}

function parseBool(value) {
  if (value === undefined) {
    return false;
  }
  const normalized = String(value).trim().toLowerCase();
  return normalized === '' || normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function parseIntArg(value, name, fallback) {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid value for --${name}: ${value}`);
  }
  return parsed;
}

function toBase64Url(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function createVerifier() {
  return toBase64Url(crypto.randomBytes(32));
}

function createState() {
  return toBase64Url(crypto.randomBytes(16));
}

function createChallenge(verifier) {
  return toBase64Url(crypto.createHash('sha256').update(verifier, 'utf8').digest());
}

function buildAuthorizationUrl({ challenge, state, redirectUri }) {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    scope: SCOPE,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    state,
    originator: ORIGINATOR,
    redirect_uri: redirectUri,
  });
  return `${AUTH_BASE_URL}?${query.toString()}`;
}

function printUsage() {
  console.log(`Get an OAuth bearer token for Codex endpoints.

Usage:
  node scripts/get-oauth-bearer-token.js [options]
  npm run oauth:token -- [options]

Options:
  --host <host>          Callback server host (default: localhost)
  --port <port>          Callback server port (default: 1455)
  --timeout-ms <ms>      Callback timeout (default: 180000)
  --no-open              Do not auto-open browser; print URL only
  --json                 Output JSON only
  --help                 Show this help
`);
}

function tryOpenBrowser(url) {
  let command;
  let args;

  if (process.platform === 'darwin') {
    command = 'open';
    args = [url];
  } else if (process.platform === 'win32') {
    command = 'cmd';
    args = ['/c', 'start', '', url];
  } else {
    command = 'xdg-open';
    args = [url];
  }

  try {
    const child = spawn(command, args, {
      stdio: 'ignore',
      detached: true,
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function startCallbackServer({ host, port, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const redirectUri = `http://${host}:${port}${CALLBACK_PATH}`;
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', redirectUri);
      if (url.pathname !== CALLBACK_PATH) {
        res.statusCode = 404;
        res.end('Not Found');
        return;
      }

      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      if (!code || !state) {
        res.statusCode = 400;
        res.end('Missing code/state. You can close this window and retry.');
        return;
      }

      res.statusCode = 200;
      res.end('Login complete. You can close this window.');
      cleanup();
      resolve({
        code,
        state,
        redirectUri,
      });
    });

    let settled = false;
    let timer = setTimeout(() => {
      timer = undefined;
      if (settled) {
        return;
      }
      settled = true;
      server.close(() => undefined);
      reject(new Error(`OAuth callback timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    const cleanup = () => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      server.close(() => undefined);
    };

    server.once('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      reject(error);
    });

    server.listen(port, host);
  });
}

async function exchangeCodeForToken({ code, verifier, redirectUri }) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: CLIENT_ID,
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
  });

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }

  if (!response.ok) {
    const details = typeof payload === 'object' ? JSON.stringify(payload) : String(payload);
    throw new Error(`Token exchange failed (${response.status}): ${details}`);
  }

  const accessToken = payload && payload.access_token;
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new Error('Token exchange succeeded but no access_token was returned.');
  }

  return {
    accessToken,
    refreshToken: typeof payload.refresh_token === 'string' ? payload.refresh_token : '',
    expiresIn: Number.isFinite(payload.expires_in) ? payload.expires_in : undefined,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (parseBool(args.help)) {
    printUsage();
    return;
  }

  const host = args.host || 'localhost';
  const port = parseIntArg(args.port, 'port', 1455);
  const timeoutMs = parseIntArg(args['timeout-ms'], 'timeout-ms', 180000);
  const noOpen = parseBool(args['no-open']);
  const asJson = parseBool(args.json);

  const verifier = createVerifier();
  const challenge = createChallenge(verifier);
  const expectedState = createState();
  const redirectUri = `http://${host}:${port}${CALLBACK_PATH}`;
  const authUrl = buildAuthorizationUrl({
    challenge,
    state: expectedState,
    redirectUri,
  });

  const callbackPromise = startCallbackServer({ host, port, timeoutMs });

  if (!asJson) {
    console.log(`[oauth] callback server listening at ${redirectUri}`);
    console.log('[oauth] complete login in browser and wait for callback...');
    console.log(`[oauth] auth url: ${authUrl}`);
  }

  if (!noOpen) {
    const opened = tryOpenBrowser(authUrl);
    if (!opened && !asJson) {
      console.log('[oauth] could not auto-open browser; open the URL above manually.');
    }
  }

  const callback = await callbackPromise;
  if (callback.state !== expectedState) {
    throw new Error('Login validation failed (state mismatch).');
  }

  const tokens = await exchangeCodeForToken({
    code: callback.code,
    verifier,
    redirectUri,
  });

  if (asJson) {
    process.stdout.write(JSON.stringify(tokens, null, 2));
    process.stdout.write('\n');
    return;
  }

  console.log('[oauth] token exchange succeeded.');
  console.log('');
  console.log('Bearer token (access_token):');
  console.log(tokens.accessToken);
  console.log('');
  console.log('Use it for bulk CLI in this shell:');
  console.log(`export TAB_AUTOCOMPLETE_BEARER_TOKEN='${tokens.accessToken}'`);
  if (tokens.expiresIn) {
    console.log(`[oauth] expires_in=${tokens.expiresIn}s`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[oauth] failed: ${message}`);
  process.exitCode = 1;
});
