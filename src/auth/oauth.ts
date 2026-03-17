import * as vscode from 'vscode';
import { createChallenge, createState, createVerifier } from './pkce';
import { startOAuthCallbackServer } from './oauthServer';

const AUTH_BASE_URL = 'https://auth.openai.com/oauth/authorize';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const REVOKE_URL = 'https://auth.openai.com/oauth/revoke';
// Match current Codex OAuth PKCE params used by OpenAI's first-party tooling.
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const SCOPE = 'openid profile email offline_access';
const ORIGINATOR = 'codex_vscode';

export interface OAuthTokenResponse {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  accountId?: string;
}

interface OAuthTokenApiResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

export class LoginCancelledError extends Error {
  constructor() {
    super('Login cancelled.');
    this.name = 'LoginCancelledError';
  }
}

export class InvalidRefreshTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRefreshTokenError';
  }
}

function decodeAccountId(accessToken: string): string | undefined {
  const parts = accessToken.split('.');
  if (parts.length < 2) {
    return undefined;
  }

  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as {
      sub?: string;
      account_id?: string;
    };
    return payload.account_id ?? payload.sub;
  } catch {
    return undefined;
  }
}

function mapTokenResponse(response: OAuthTokenApiResponse): OAuthTokenResponse {
  return {
    accessToken: response.access_token,
    refreshToken: response.refresh_token,
    expiresIn: response.expires_in,
    accountId: decodeAccountId(response.access_token),
  };
}

function parseExternalUrl(rawUrl: string): vscode.Uri {
  let normalizedUrl: string;
  try {
    normalizedUrl = new URL(rawUrl).toString();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    throw new Error(`Invalid external URL (${rawUrl}): ${message}`);
  }

  try {
    return vscode.Uri.parse(normalizedUrl);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    throw new Error(`Failed to parse external URL (${normalizedUrl}): ${message}`);
  }
}

async function exchangeCodeForTokens(code: string, verifier: string, redirectUri: string): Promise<OAuthTokenResponse> {
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

  if (!response.ok) {
    throw new Error(`Token exchange failed (${response.status}).`);
  }

  const payload = (await response.json()) as OAuthTokenApiResponse;
  return mapTokenResponse(payload);
}

export function buildAuthorizationUrl(challenge: string, state: string, redirectUri: string): string {
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

async function promptForCallbackUrl(expectedState: string): Promise<string> {
  const callbackUrl = await vscode.window.showInputBox({
    title: 'Codex Autocomplete Login',
    prompt: 'Paste the full redirect URL from your browser',
    ignoreFocusOut: true,
  });

  if (!callbackUrl) {
    throw new LoginCancelledError();
  }

  const url = new URL(callbackUrl);
  const state = url.searchParams.get('state');
  if (state !== expectedState) {
    throw new Error('Login validation failed (state mismatch).');
  }

  const code = url.searchParams.get('code');
  if (!code) {
    throw new Error('Login validation failed (missing code).');
  }

  return code;
}

export async function beginLogin(): Promise<OAuthTokenResponse> {
  const verifier = createVerifier();
  const challenge = await createChallenge(verifier);
  const state = createState();
  const callbackServer = await startOAuthCallbackServer();
  const authUrl = buildAuthorizationUrl(challenge, state, callbackServer.redirectUri);

  const authUri = parseExternalUrl(authUrl);
  await vscode.env.openExternal(authUri);

  let code: string;
  try {
    const callback = await callbackServer.waitForCallback();
    if (callback.state !== state) {
      throw new Error('Login validation failed (state mismatch).');
    }
    code = callback.code;
  } catch {
    const choice = await vscode.window.showWarningMessage(
      'Could not receive OAuth callback automatically. Paste the redirect URL to continue login.',
      'Paste Redirect URL',
      'Cancel',
    );

    if (choice !== 'Paste Redirect URL') {
      callbackServer.dispose();
      throw new LoginCancelledError();
    }

    code = await promptForCallbackUrl(state);
  } finally {
    callbackServer.dispose();
  }

  return exchangeCodeForTokens(code, verifier, callbackServer.redirectUri);
}

export async function refreshAccessToken(refreshToken: string): Promise<OAuthTokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: CLIENT_ID,
    refresh_token: refreshToken,
  });

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  if (response.status === 400 || response.status === 401) {
    throw new InvalidRefreshTokenError('Refresh token is invalid or expired.');
  }

  if (!response.ok) {
    throw new Error(`Token refresh failed (${response.status}).`);
  }

  const payload = (await response.json()) as OAuthTokenApiResponse;
  return mapTokenResponse(payload);
}

export async function revokeToken(token: string): Promise<void> {
  if (!token) {
    return;
  }

  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    token,
  });

  await fetch(REVOKE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
}
