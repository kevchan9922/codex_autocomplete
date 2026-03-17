import { CompletionContext } from './contextBuilder';

export function buildPromptCacheKey(
  namespace: string | undefined,
  context: CompletionContext,
): string {
  const normalizedPath = context.filePath.replace(/\\/g, '/');
  const pathParts = normalizedPath.split('/').filter(Boolean);
  const repoHint = pathParts.length >= 2 ? pathParts[pathParts.length - 2] : 'repo';
  const symbolHint = inferSymbolHint(context.beforeLines);
  const coarseLineBucket = Math.floor(context.cursor.line / 40).toString();
  const fingerprint = stableHash(
    [
      context.languageId,
      normalizedPath,
      symbolHint,
      coarseLineBucket,
    ].join('|'),
  );

  const keyParts = [
    sanitizeKeyPart(namespace ?? 'codex-autocomplete'),
    sanitizeKeyPart(repoHint),
    sanitizeKeyPart(context.languageId),
    sanitizeKeyPart(symbolHint),
    fingerprint,
  ];

  return keyParts.join(':');
}

function inferSymbolHint(beforeLines: string[]): string {
  for (let i = beforeLines.length - 1; i >= 0; i -= 1) {
    const line = beforeLines[i].trim();
    if (!line) {
      continue;
    }

    const patterns = [
      /(?:function|def|class)\s+([A-Za-z_][\w]*)/,
      /([A-Za-z_][\w]*)\s*\(/,
    ];

    for (const pattern of patterns) {
      const match = pattern.exec(line);
      if (match?.[1]) {
        return match[1];
      }
    }
  }

  return 'global';
}

function sanitizeKeyPart(value: string): string {
  const sanitized = value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  return sanitized.slice(0, 40) || 'x';
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
