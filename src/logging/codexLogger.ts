export type CodexLogLevel = 'debug' | 'info' | 'warn' | 'error' | 'off';
export type CodexLogSink = (formattedMessage: string) => void;

export interface CodexLogLevelStats {
  attempted: number;
  emitted: number;
  suppressed: number;
  emitTimeMs: number;
}

export interface CodexLogStatsSnapshot {
  sequence: number;
  levels: Record<CodexLogLevel, CodexLogLevelStats>;
}

const LOG_LEVEL_PRIORITY: Record<CodexLogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  off: 100,
};

const DEFAULT_LOG_LEVEL: CodexLogLevel = 'info';
const MAX_LOG_MESSAGE_LENGTH = 3000;

let currentLogLevel: CodexLogLevel = DEFAULT_LOG_LEVEL;
let codexLogSequence = 0;
let currentLogSink: CodexLogSink | undefined;

const logStatsByLevel: Record<CodexLogLevel, CodexLogLevelStats> = {
  debug: { attempted: 0, emitted: 0, suppressed: 0, emitTimeMs: 0 },
  info: { attempted: 0, emitted: 0, suppressed: 0, emitTimeMs: 0 },
  warn: { attempted: 0, emitted: 0, suppressed: 0, emitTimeMs: 0 },
  error: { attempted: 0, emitted: 0, suppressed: 0, emitTimeMs: 0 },
  off: { attempted: 0, emitted: 0, suppressed: 0, emitTimeMs: 0 },
};

export function setCodexLogLevel(level: string | undefined): void {
  currentLogLevel = normalizeLogLevel(level);
}

export function getCodexLogLevel(): CodexLogLevel {
  return currentLogLevel;
}

export function setCodexLogSink(sink: CodexLogSink | undefined): void {
  currentLogSink = sink;
}


export function getCodexLogStatsSnapshot(): CodexLogStatsSnapshot {
  return {
    sequence: codexLogSequence,
    levels: {
      debug: { ...logStatsByLevel.debug },
      info: { ...logStatsByLevel.info },
      warn: { ...logStatsByLevel.warn },
      error: { ...logStatsByLevel.error },
      off: { ...logStatsByLevel.off },
    },
  };
}

export function codexDebug(message: string): void {
  emit('debug', message);
}

export function codexInfo(message: string): void {
  emit('info', message);
}

export function codexWarn(message: string): void {
  emit('warn', message);
}

export function codexError(message: string): void {
  emit('error', message);
}

// Backward-compatible helper used throughout the codebase.
export function codexLog(message: string): void {
  codexInfo(message);
}

export function codexLogPayload(
  label: string,
  payload: string,
  level: CodexLogLevel = 'info',
  maxChunkChars = 2200,
): void {
  if (!shouldLog(level)) {
    return;
  }

  if (payload.length <= maxChunkChars) {
    emit(level, `${label} ${payload}`);
    return;
  }

  const chunkCount = Math.ceil(payload.length / maxChunkChars);
  emit(level, `${label} length=${payload.length} chunkCount=${chunkCount}`);
  for (let index = 0; index < chunkCount; index += 1) {
    const start = index * maxChunkChars;
    const end = start + maxChunkChars;
    const chunk = payload.slice(start, end);
    emit(level, `${label} chunk=${index + 1}/${chunkCount} ${chunk}`);
  }
}

function emit(level: CodexLogLevel, message: string): void {
  const levelStats = logStatsByLevel[level];
  levelStats.attempted += 1;

  if (!shouldLog(level)) {
    levelStats.suppressed += 1;
    return;
  }

  const startedAtMs = Date.now();
  codexLogSequence += 1;
  const timestamp = new Date().toISOString();
  const safeMessage = sanitizeMessage(message);
  const formatted = `[codex][${codexLogSequence}][${timestamp}][${level.toUpperCase()}] ${safeMessage}`;
  console.log(formatted);
  currentLogSink?.(formatted);
  levelStats.emitted += 1;
  levelStats.emitTimeMs += Date.now() - startedAtMs;
}

function shouldLog(level: CodexLogLevel): boolean {
  return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[currentLogLevel];
}

function normalizeLogLevel(value: string | undefined): CodexLogLevel {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === 'debug'
    || normalized === 'info'
    || normalized === 'warn'
    || normalized === 'error'
    || normalized === 'off'
  ) {
    return normalized;
  }
  return DEFAULT_LOG_LEVEL;
}

function sanitizeMessage(message: string): string {
  let result = redactSensitiveData(message);
  if (result.length > MAX_LOG_MESSAGE_LENGTH) {
    const truncatedChars = result.length - MAX_LOG_MESSAGE_LENGTH;
    result = `${result.slice(0, MAX_LOG_MESSAGE_LENGTH)} …[truncated ${truncatedChars} chars]`;
  }
  return result;
}

function redactSensitiveData(message: string): string {
  return message
    .replace(/\bBearer\s+[A-Za-z0-9._~-]+/g, 'Bearer [REDACTED]')
    .replace(/("access_token"\s*:\s*")[^"]+(")/gi, '$1[REDACTED]$2')
    .replace(/("refresh_token"\s*:\s*")[^"]+(")/gi, '$1[REDACTED]$2')
    .replace(/("Authorization"\s*:\s*"Bearer\s+)[^"]+(")/gi, '$1[REDACTED]$2');
}
