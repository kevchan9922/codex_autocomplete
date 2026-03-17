import * as vscode from 'vscode';
import { codexLog } from '../logging/codexLogger';
import {
  buildExtraContextFromText,
  ExtraContextOptions,
  RecentContextEntry,
  RecencyContextStore,
  resolveExtraContextOptions,
  SYMBOL_LOOKUP_TIMEOUT_MS,
} from './contextEnrichmentCore';

export type { ExtraContextOptions, RecentContextEntry, RecencyStoreOptions } from './contextEnrichmentCore';
export { RecencyContextStore } from './contextEnrichmentCore';

const SYMBOL_CACHE_TTL_MS = 1_500;

interface CachedSymbol {
  value?: string;
  expiresAt: number;
}

const symbolCache = new Map<string, CachedSymbol>();

export async function buildExtraContext(
  document: vscode.TextDocument,
  position: vscode.Position,
  text: string,
  recentEntries: RecentContextEntry[],
  options: ExtraContextOptions = {},
): Promise<string | undefined> {
  const config = resolveExtraContextOptions(options);
  let currentSymbol: string | undefined;

  if (config.includeCurrentSymbol) {
    currentSymbol = await getCurrentSymbolName(
      document,
      position,
      config.symbolLookupTimeoutMs,
    );
  }

  return buildExtraContextFromText({
    text,
    recentEntries,
    currentSymbol,
    options: config,
  });
}

async function getCurrentSymbolName(
  document: vscode.TextDocument,
  position: vscode.Position,
  timeoutMs: number,
): Promise<string | undefined> {
  const docWithVersion = document as vscode.TextDocument & { version?: number };
  const key = `${document.uri.toString()}::${typeof docWithVersion.version === 'number' ? docWithVersion.version : 0}::${Math.floor(position.line / 20)}`;
  const now = Date.now();
  const cached = symbolCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  try {
    const symbols = await withTimeout(
      vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider',
        document.uri,
      ),
      timeoutMs,
    );

    if (!symbols || symbols.length === 0) {
      return undefined;
    }

    const match = findDeepestSymbol(symbols, position);
    const value = match?.name;
    symbolCache.set(key, { value, expiresAt: now + SYMBOL_CACHE_TTL_MS });
    return value;
  } catch {
    codexLog(
      `[codex] current-symbol lookup skipped after timeout/error timeoutMs=${timeoutMs}ms`,
    );
    symbolCache.set(key, { value: undefined, expiresAt: now + SYMBOL_CACHE_TTL_MS });
    return undefined;
  }
}

async function withTimeout<T>(promise: PromiseLike<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => {
          codexLog(`[codex] context enrichment timeout reached (${timeoutMs}ms)`);
          reject(new Error('timeout'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function findDeepestSymbol(
  symbols: vscode.DocumentSymbol[],
  position: vscode.Position,
): vscode.DocumentSymbol | undefined {
  for (const symbol of symbols) {
    if (isPositionInRange(position, symbol.range)) {
      const child = symbol.children ? findDeepestSymbol(symbol.children, position) : undefined;
      return child ?? symbol;
    }
  }
  return undefined;
}

function isPositionInRange(position: vscode.Position, range: vscode.Range): boolean {
  if (position.line < range.start.line || position.line > range.end.line) {
    return false;
  }
  if (position.line === range.start.line && position.character < range.start.character) {
    return false;
  }
  if (position.line === range.end.line && position.character > range.end.character) {
    return false;
  }
  return true;
}

export { SYMBOL_LOOKUP_TIMEOUT_MS };
