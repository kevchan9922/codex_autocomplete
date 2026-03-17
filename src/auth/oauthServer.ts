import * as http from 'node:http';

export interface OAuthCallbackResult {
  code: string;
  state: string;
}

export interface OAuthServerOptions {
  host?: string;
  port?: number;
  portFallbackCount?: number;
  timeoutMs?: number;
}

const DEFAULT_HOST = 'localhost';
const DEFAULT_PORT = 1455;
const DEFAULT_CALLBACK_PATH = '/auth/callback';
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_PORT_FALLBACK_COUNT = 5;

export function buildRedirectUri(options?: OAuthServerOptions): string {
  const host = options?.host ?? DEFAULT_HOST;
  const port = options?.port ?? DEFAULT_PORT;
  return `http://${host}:${port}${DEFAULT_CALLBACK_PATH}`;
}

export interface OAuthCallbackServer {
  redirectUri: string;
  waitForCallback: () => Promise<OAuthCallbackResult>;
  dispose: () => void;
}

export async function startOAuthCallbackServer(
  options?: OAuthServerOptions,
): Promise<OAuthCallbackServer> {
  const host = options?.host ?? DEFAULT_HOST;
  const basePort = options?.port ?? DEFAULT_PORT;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const portFallbackCount = options?.portFallbackCount ?? DEFAULT_PORT_FALLBACK_COUNT;

  let lastError: Error | undefined;

  for (let offset = 0; offset <= portFallbackCount; offset += 1) {
    const port = basePort + offset;
    const redirectUri = buildRedirectUri({ host, port });
    const server = http.createServer((_req: unknown, _res: unknown) => undefined) as unknown as {
      once: (event: string, listener: (...args: any[]) => void) => void;
      on: (event: string, listener: (...args: any[]) => void) => void;
      off: (event: string, listener: (...args: any[]) => void) => void;
      listen: (port: number, host: string) => void;
      close: (callback?: () => void) => void;
    };

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
      });
    } catch (error) {
      server.close(() => undefined);
      const code = (error as { code?: string }).code;
      if (code === 'EADDRINUSE') {
        lastError = error as Error;
        continue;
      }
      throw error;
    }

    let cleanupCalled = false;
    let rejectCallback: ((error: Error) => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (cleanupCalled) {
        return;
      }
      cleanupCalled = true;
      if (timer) {
        clearTimeout(timer);
      }
      server.close(() => undefined);
    };

    const callbackPromise = new Promise<OAuthCallbackResult>((resolve, reject) => {
      rejectCallback = reject;
      server.on('request', (req: { url?: string }, res: { statusCode: number; end: (body: string) => void }) => {
        const requestUrl = new URL(req.url ?? '/', redirectUri);
        const code = requestUrl.searchParams.get('code');
        const state = requestUrl.searchParams.get('state');

        if (!code || !state) {
          res.statusCode = 400;
          res.end('Missing code/state. You can close this window and try login again.');
          return;
        }

        res.statusCode = 200;
        res.end('Login complete. You can close this window and return to VS Code.');

        cleanup();
        resolve({ code, state });
      });

      server.once('error', (error) => {
        cleanup();
        reject(error);
      });
    });

    timer = setTimeout(() => {
      const error = new Error('OAuth callback timed out.');
      if (rejectCallback) {
        rejectCallback(error);
      } else {
        cleanup();
      }
    }, timeoutMs);

    const waitForCallback = async () => {
      try {
        return await callbackPromise;
      } catch (error) {
        throw error;
      } finally {
        cleanup();
      }
    };

    return {
      redirectUri,
      waitForCallback,
      dispose: cleanup,
    };
  }

  throw lastError ?? new Error('Unable to start OAuth callback server.');
}
