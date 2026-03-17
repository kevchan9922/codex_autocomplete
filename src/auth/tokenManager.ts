import * as vscode from 'vscode';
import { InvalidRefreshTokenError, OAuthTokenResponse, refreshAccessToken, revokeToken } from './oauth';

export class NotAuthenticatedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotAuthenticatedError';
  }
}

interface StoredTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  accountId?: string;
}

const STORAGE_KEY = 'tabAutocomplete.tokens';
const EXPIRY_SKEW_MS = 30_000;

export class TokenManager {
  private refreshInFlight?: Promise<string>;
  private invalidationCounter = 0;

  constructor(private readonly storage: vscode.SecretStorage) {}

  async saveTokens(tokens: OAuthTokenResponse): Promise<void> {
    const expiresAt =
      typeof tokens.expiresIn === 'number' ? Date.now() + tokens.expiresIn * 1000 : undefined;

    const stored: StoredTokens = {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt,
      accountId: tokens.accountId,
    };

    await this.storage.store(STORAGE_KEY, JSON.stringify(stored));
  }

  async clearTokens(): Promise<void> {
    this.invalidationCounter += 1;
    this.refreshInFlight = undefined;
    await this.storage.delete(STORAGE_KEY);
  }

  async logout(): Promise<void> {
    const stored = await this.readTokens();
    await this.clearTokens();

    const revokeTasks: Promise<void>[] = [];
    if (stored?.refreshToken) {
      revokeTasks.push(revokeToken(stored.refreshToken));
    }
    if (stored?.accessToken) {
      revokeTasks.push(revokeToken(stored.accessToken));
    }

    await Promise.allSettled(revokeTasks);
  }

  async hasToken(): Promise<boolean> {
    const stored = await this.readTokens();
    return Boolean(stored?.accessToken);
  }

  async getAccessToken(): Promise<string> {
    const stored = await this.readTokens();
    if (!stored) {
      throw new NotAuthenticatedError('Not logged in.');
    }

    if (!this.isExpired(stored.expiresAt)) {
      return stored.accessToken;
    }

    if (!stored.refreshToken) {
      await this.clearTokens();
      throw new NotAuthenticatedError('Session expired. Please login again.');
    }

    return this.refreshWithLock(stored);
  }

  async getTokenTypeHint(): Promise<'oauth' | 'apiKey' | 'unknown'> {
    const stored = await this.readTokens();
    if (!stored?.accessToken) {
      return 'unknown';
    }

    const token = stored.accessToken;
    if (token.startsWith('sk-')) {
      return 'apiKey';
    }

    const segments = token.split('.');
    if (segments.length === 3) {
      return 'oauth';
    }

    return 'unknown';
  }

  private refreshWithLock(stored: StoredTokens): Promise<string> {
    const invalidationAtStart = this.invalidationCounter;
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.performRefresh(stored, invalidationAtStart).finally(() => {
        this.refreshInFlight = undefined;
      });
    }

    return this.refreshInFlight;
  }

  private async performRefresh(
    stored: StoredTokens,
    invalidationAtStart: number,
  ): Promise<string> {
    try {
      const refreshed = await refreshAccessToken(stored.refreshToken as string);
      if (invalidationAtStart !== this.invalidationCounter) {
        throw new NotAuthenticatedError('Not logged in.');
      }
      const merged: OAuthTokenResponse = {
        ...refreshed,
        refreshToken: refreshed.refreshToken ?? stored.refreshToken,
        accountId: refreshed.accountId ?? stored.accountId,
      };
      await this.saveTokens(merged);
      return merged.accessToken;
    } catch (err) {
      if (err instanceof InvalidRefreshTokenError) {
        await this.clearTokens();
        throw new NotAuthenticatedError('Session expired. Please login again.');
      }
      throw err;
    }
  }

  private async readTokens(): Promise<StoredTokens | undefined> {
    const raw = await this.storage.get(STORAGE_KEY);
    if (!raw) {
      return undefined;
    }

    try {
      return JSON.parse(raw) as StoredTokens;
    } catch {
      await this.clearTokens();
      return undefined;
    }
  }

  private isExpired(expiresAt?: number): boolean {
    if (!expiresAt) {
      return false;
    }
    return Date.now() >= expiresAt - EXPIRY_SKEW_MS;
  }
}
