#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createAIProvider } = require('../out/api/providerFactory.js');
const { runAutocompleteBulkTest } = require('../out/debug/bulkTestRunner.js');
const {
  buildCompletionContext,
  DEFAULT_CONTEXT_CONFIG,
} = require('../out/completion/contextBuilder.js');
const { buildExtraContextFromText } = require('../out/completion/contextEnrichmentCore.js');
const { setCodexLogLevel } = require('../out/logging/codexLogger.js');

const OAUTH_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses';
const API_KEY_ENDPOINT = 'https://api.openai.com/v1/responses';
const DEFAULT_MODEL = 'gpt-5.4';
const DEFAULT_INSTRUCTIONS =
  'Return only the text to insert at cursor. No explanation. Output the shortest valid completion. If a plausible insertion exists, do not return empty output. For code files, return code. For markdown/plaintext files, return document text and continue local structure on blank lines.';
const DEFAULT_BENCHMARK_RATE_LIMIT_WINDOW_SEC = 1;
const DEFAULT_BENCHMARK_RATE_LIMIT_MAX_REQUESTS = 1000;
const OAUTH_TEST_TOKEN_PATHS = [
  path.join('test', 'artifacts', 'oauth_test_token.txt'),
  path.join('test_files', 'oauth_test_token.txt'),
];
const REMOVED_HOTKEY_BENCHMARK_FLAGS = [
  'hotkey-max-latency-ms',
  'hotkey-first-chunk-max-latency-ms',
  'hotkey-fast-stage-max-latency-ms',
  'hotkey-fast-stage-prefix-lines',
  'hotkey-fast-stage-suffix-lines',
  'hotkey-semantic-retry-enabled',
  'hotkey-semantic-retry-max-latency-ms',
  'hotkey-semantic-retry-first-chunk-max-latency-ms',
];

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith('--')) {
      continue;
    }
    const withoutPrefix = current.slice(2);
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

function parseInteger(value, name) {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid integer for --${name}: ${value}`);
  }
  return parsed;
}

function parseBooleanFlag(value) {
  if (value === undefined) {
    return false;
  }
  return parseOptionalBooleanFlag(value, 'boolean-flag') === true;
}

function parseOptionalBooleanFlag(value, name) {
  if (value === undefined) {
    return undefined;
  }
  const normalized = String(value).trim().toLowerCase();
  if (normalized === '' || normalized === '1' || normalized === 'true' || normalized === 'yes') {
    return true;
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'no') {
    return false;
  }
  throw new Error(`Invalid boolean for --${name}: ${value}`);
}

function parseBenchmarkMode(value) {
  if (value === undefined) {
    return 'hotkey_inline';
  }
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'direct' || normalized === 'hotkey_inline') {
    return normalized;
  }
  throw new Error(
    `Invalid --benchmark-mode: ${value}. Expected "hotkey_inline" or "direct".`,
  );
}

function assertNoRemovedHotkeyBenchmarkArgs(args) {
  const usedFlags = REMOVED_HOTKEY_BENCHMARK_FLAGS.filter((flag) =>
    Object.prototype.hasOwnProperty.call(args, flag),
  );
  if (usedFlags.length === 0) {
    return;
  }

  throw new Error(
    `Unsupported benchmark options: ${usedFlags.map((flag) => `--${flag}`).join(', ')}. CLI benchmarks use built-in hotkey defaults and no longer accept hotkey/fast-stage tuning flags.`,
  );
}

function resolveRateLimitConfig(args) {
  return {
    rateLimitWindowSec:
      parseInteger(args['rate-limit-window-sec'], 'rate-limit-window-sec')
      ?? DEFAULT_BENCHMARK_RATE_LIMIT_WINDOW_SEC,
    rateLimitMaxRequests:
      parseInteger(args['rate-limit-max-requests'], 'rate-limit-max-requests')
      ?? DEFAULT_BENCHMARK_RATE_LIMIT_MAX_REQUESTS,
  };
}

function normalizeTokenCandidate(value) {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

async function resolveAuthToken(workspaceFolder, cliToken) {
  const directToken = normalizeTokenCandidate(cliToken);
  if (directToken) {
    return directToken;
  }

  const envBearerToken = normalizeTokenCandidate(process.env.TAB_AUTOCOMPLETE_BEARER_TOKEN);
  if (envBearerToken) {
    return envBearerToken;
  }

  for (const relativePath of OAUTH_TEST_TOKEN_PATHS) {
    const candidatePath = path.join(workspaceFolder, relativePath);
    try {
      const tokenFromFile = normalizeTokenCandidate(await fs.readFile(candidatePath, 'utf8'));
      if (tokenFromFile) {
        return tokenFromFile;
      }
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') {
        continue;
      }
      throw error;
    }
  }

  return normalizeTokenCandidate(process.env.OPENAI_API_KEY);
}

function inferLanguageId(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.py':
      return 'python';
    case '.ts':
      return 'typescript';
    case '.tsx':
      return 'typescriptreact';
    case '.js':
      return 'javascript';
    case '.jsx':
      return 'javascriptreact';
    case '.java':
      return 'java';
    case '.go':
      return 'go';
    case '.rs':
      return 'rust';
    case '.cs':
      return 'csharp';
    case '.cpp':
    case '.cc':
    case '.cxx':
    case '.hpp':
      return 'cpp';
    default:
      return 'plaintext';
  }
}

function resolveEndpoint(token, explicitEndpoint) {
  if (explicitEndpoint) {
    return explicitEndpoint;
  }
  return token.startsWith('sk-') ? API_KEY_ENDPOINT : OAUTH_ENDPOINT;
}

async function buildContextString({
  contextFilePath,
  languageId,
  cursorLineOneBased,
  cursorCharOneBased,
  maxContextLines,
  maxFileLines,
}) {
  const text = await fs.readFile(contextFilePath, 'utf8');
  return buildRuntimeAlignedContextStringFromText({
    text,
    filePath: contextFilePath,
    languageId,
    cursorLineOneBased,
    cursorCharOneBased,
    maxContextLines,
    maxFileLines,
  });
}

function buildContextStringFromText({
  text,
  filePath,
  languageId,
  cursorLineOneBased,
  cursorCharOneBased,
  maxContextLines,
  maxFileLines,
}) {
  const lines = text.split(/\r?\n/);
  const maxLineIndex = Math.max(0, lines.length - 1);

  const requestedLine = cursorLineOneBased === undefined
    ? maxLineIndex
    : Math.max(0, cursorLineOneBased - 1);
  const safeLine = Math.min(requestedLine, maxLineIndex);

  const currentLine = lines[safeLine] ?? '';
  const maxChar = currentLine.length;
  const requestedChar = cursorCharOneBased === undefined
    ? maxChar
    : Math.max(0, cursorCharOneBased - 1);
  const safeChar = Math.min(requestedChar, maxChar);

  const contextResult = buildCompletionContext(
    {
      text,
      languageId,
      filePath,
    },
    {
      line: safeLine,
      character: safeChar,
    },
    {
      ...DEFAULT_CONTEXT_CONFIG,
      maxBeforeLines: maxContextLines,
      maxFileLines,
    },
  );

  if (contextResult.skip) {
    return JSON.stringify({
      skipped: true,
      reason: contextResult.reason,
      lineCount: contextResult.lineCount,
    });
  }

  return JSON.stringify(contextResult.context, null, 2);
}

async function buildRuntimeAlignedContextStringFromText({
  text,
  filePath,
  languageId,
  cursorLineOneBased,
  cursorCharOneBased,
  maxContextLines,
  maxFileLines,
}) {
  const lines = text.split(/\r?\n/);
  const maxLineIndex = Math.max(0, lines.length - 1);

  const requestedLine = cursorLineOneBased === undefined
    ? maxLineIndex
    : Math.max(0, cursorLineOneBased - 1);
  const safeLine = Math.min(requestedLine, maxLineIndex);

  const currentLine = lines[safeLine] ?? '';
  const maxChar = currentLine.length;
  const requestedChar = cursorCharOneBased === undefined
    ? maxChar
    : Math.max(0, cursorCharOneBased - 1);
  const safeChar = Math.min(requestedChar, maxChar);

  const contextResult = buildCompletionContext(
    {
      text,
      languageId,
      filePath,
    },
    {
      line: safeLine,
      character: safeChar,
    },
    {
      ...DEFAULT_CONTEXT_CONFIG,
      maxBeforeLines: maxContextLines,
      maxFileLines,
    },
  );

  if (contextResult.skip) {
    return JSON.stringify({
      skipped: true,
      reason: contextResult.reason,
      lineCount: contextResult.lineCount,
    });
  }

  const extraContext = buildExtraContextFromText({
    text,
    recentEntries: [],
    options: {
      includeCurrentSymbol: false,
    },
  });

  return JSON.stringify({
    ...contextResult.context,
    context: extraContext,
  }, null, 2);
}

function findCursorOffsetAfterMarker(text, marker, occurrence = 1) {
  if (!marker) {
    return -1;
  }

  let fromIndex = 0;
  let foundAt = -1;
  for (let hit = 0; hit < occurrence; hit += 1) {
    const index = text.indexOf(marker, fromIndex);
    if (index < 0) {
      return -1;
    }
    foundAt = index;
    fromIndex = index + marker.length;
  }
  return foundAt + marker.length;
}

function offsetToLineCharacter(text, offset) {
  const before = text.slice(0, offset);
  const lines = before.split(/\r?\n/);
  const line = Math.max(0, lines.length - 1);
  const character = lines[lines.length - 1] ? lines[lines.length - 1].length : 0;
  return { line, character };
}

async function buildContextStringForRow({
  row,
  workspaceFolder,
  defaultContextFilePath,
  defaultLanguageId,
  defaultCursorLine,
  defaultCursorChar,
  maxContextLines,
  maxFileLines,
  scopeMode,
}) {
  const contextFileInput = row.filePath || defaultContextFilePath;
  const contextFilePath = path.isAbsolute(contextFileInput)
    ? contextFileInput
    : path.join(workspaceFolder, contextFileInput);
  const languageId = row.languageId || defaultLanguageId || inferLanguageId(contextFilePath);
  const source = await fs.readFile(contextFilePath, 'utf8');

  let cursorLineOneBased = row.cursorLine;
  let cursorCharOneBased = row.cursorChar;

  if (cursorLineOneBased === undefined && row.cursorAfter) {
    const occurrence = row.cursorAfterOccurrence || 1;
    const cursorOffset = findCursorOffsetAfterMarker(source, row.cursorAfter, occurrence);
    if (cursorOffset < 0) {
      throw new Error(
        `Cursor marker not found for test "${row.test}" in ${contextFilePath}: ${row.cursorAfter}`,
      );
    }
    const position = offsetToLineCharacter(source, cursorOffset);
    cursorLineOneBased = position.line + 1;
    cursorCharOneBased = position.character + 1;
  }
  const resolvedCursorLineOneBased = cursorLineOneBased ?? defaultCursorLine;
  const resolvedCursorCharOneBased = cursorCharOneBased ?? defaultCursorChar;

  if (scopeMode === 'function') {
    const scoped = extractLocalScopeText({
      text: source,
      languageId,
      cursorLineOneBased: resolvedCursorLineOneBased,
      cursorCharOneBased: resolvedCursorCharOneBased,
    });
    if (scoped) {
      return buildRuntimeAlignedContextStringFromText({
        text: scoped.text,
        filePath: contextFilePath,
        languageId,
        cursorLineOneBased: scoped.cursorLineOneBased,
        cursorCharOneBased: scoped.cursorCharOneBased,
        maxContextLines,
        maxFileLines,
      });
    }
  }

  return buildRuntimeAlignedContextStringFromText({
    text: source,
    filePath: contextFilePath,
    languageId,
    cursorLineOneBased: resolvedCursorLineOneBased,
    cursorCharOneBased: resolvedCursorCharOneBased,
    maxContextLines,
    maxFileLines,
  });
}

function extractLocalScopeText({ text, languageId, cursorLineOneBased, cursorCharOneBased }) {
  if (!cursorLineOneBased || !cursorCharOneBased) {
    return undefined;
  }
  const lines = text.split(/\r?\n/);
  const cursorLine = Math.max(0, Math.min(lines.length - 1, cursorLineOneBased - 1));
  const cursorChar = Math.max(0, cursorCharOneBased - 1);

  if (languageId === 'python') {
    return extractPythonScope(lines, cursorLine, cursorChar);
  }

  if (isBraceLanguage(languageId)) {
    return extractBraceScope(text, lines, cursorLine, cursorChar);
  }

  return undefined;
}

function isBraceLanguage(languageId) {
  return new Set([
    'typescript',
    'typescriptreact',
    'javascript',
    'javascriptreact',
    'java',
    'go',
    'rust',
    'csharp',
  ]).has(languageId);
}

function extractPythonScope(lines, cursorLine, cursorChar) {
  const functionStart = findPythonFunctionStart(lines, cursorLine);
  if (functionStart < 0) {
    return undefined;
  }

  const baseIndent = lineIndent(lines[functionStart]);
  let functionEnd = lines.length - 1;
  for (let line = functionStart + 1; line < lines.length; line += 1) {
    const current = lines[line];
    if (!current.trim()) {
      continue;
    }
    if (lineIndent(current) <= baseIndent) {
      functionEnd = line - 1;
      break;
    }
  }

  if (cursorLine < functionStart || cursorLine > functionEnd) {
    return undefined;
  }

  return {
    text: lines.slice(functionStart, functionEnd + 1).join('\n'),
    cursorLineOneBased: cursorLine - functionStart + 1,
    cursorCharOneBased: cursorChar + 1,
  };
}

function findPythonFunctionStart(lines, cursorLine) {
  for (let line = cursorLine; line >= 0; line -= 1) {
    if (/^\s*(async\s+def|def)\s+[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(lines[line])) {
      return line;
    }
  }
  return -1;
}

function lineIndent(line) {
  const match = line.match(/^\s*/);
  return match ? match[0].length : 0;
}

function extractBraceScope(text, lines, cursorLine, cursorChar) {
  const lineOffsets = computeLineOffsets(text);
  const cursorOffset = lineOffsets[cursorLine] + cursorChar;
  const braceRange = findEnclosingBraceRange(text, cursorOffset);
  if (!braceRange) {
    return undefined;
  }

  const openLine = offsetToLine(lineOffsets, braceRange.openOffset);
  const closeLine = offsetToLine(lineOffsets, braceRange.closeOffset);
  if (cursorLine < openLine || cursorLine > closeLine) {
    return undefined;
  }

  let scopeStart = openLine;
  for (let line = openLine - 1; line >= Math.max(0, openLine - 4); line -= 1) {
    const trimmed = lines[line].trim();
    if (!trimmed) {
      break;
    }
    if (/^(@|\[)/.test(trimmed)) {
      scopeStart = line;
      continue;
    }
    scopeStart = line;
  }

  return {
    text: lines.slice(scopeStart, closeLine + 1).join('\n'),
    cursorLineOneBased: cursorLine - scopeStart + 1,
    cursorCharOneBased: cursorChar + 1,
  };
}

function computeLineOffsets(text) {
  const offsets = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') {
      offsets.push(index + 1);
    }
  }
  return offsets;
}

function offsetToLine(lineOffsets, offset) {
  let low = 0;
  let high = lineOffsets.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const start = lineOffsets[mid];
    const nextStart = mid + 1 < lineOffsets.length ? lineOffsets[mid + 1] : Number.POSITIVE_INFINITY;
    if (offset >= start && offset < nextStart) {
      return mid;
    }
    if (offset < start) {
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  return Math.max(0, lineOffsets.length - 1);
}

function findEnclosingBraceRange(text, cursorOffset) {
  let depth = 0;
  let openOffset = -1;
  for (let index = Math.max(0, cursorOffset - 1); index >= 0; index -= 1) {
    const ch = text[index];
    if (ch === '}') {
      depth += 1;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) {
        openOffset = index;
        break;
      }
      depth -= 1;
    }
  }
  if (openOffset < 0) {
    return undefined;
  }

  depth = 1;
  let closeOffset = -1;
  for (let index = openOffset + 1; index < text.length; index += 1) {
    const ch = text[index];
    if (ch === '{') {
      depth += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        closeOffset = index;
        break;
      }
    }
  }
  if (closeOffset < 0) {
    return undefined;
  }
  return { openOffset, closeOffset };
}

function printUsage() {
  console.log(`Run bulk autocomplete test without Extension Development Host.

Usage:
  npm run bulk:test:cli -- [options]

Required auth:
  - Set TAB_AUTOCOMPLETE_BEARER_TOKEN, or
  - Write a token to test/artifacts/oauth_test_token.txt, or
  - Write a token to test_files/oauth_test_token.txt, or
  - Set OPENAI_API_KEY

Options:
  --workspace <path>            Workspace root (default: current directory)
  --input-file <path>           Bulk test input JSON path relative to workspace
                                (default: test_files/autocomplete_test_input.json)
  --file <path>                 Context source file path relative to workspace
                                (default: test_files/python/simple_autocomplete.py)
                                (used as fallback when a test row does not specify file_path/cursor metadata)
  --language <id>               Override language id (default: inferred from --file)
  --cursor-line <n>             1-based cursor line for context extraction (default: EOF line)
  --cursor-char <n>             1-based cursor char for context extraction (default: EOL char)
  --endpoint <url>              API endpoint (default: inferred from token type)
  --model <name>                Model (default: gpt-5.4)
  --instructions <text>         Request instructions
  --max-output-tokens <n>       Max output tokens
  --service-tier <tier>         Service tier
  --prompt-cache-key <key>      Prompt cache key
  --prompt-cache-retention <v>  Prompt cache retention
  --benchmark-mode <mode>       hotkey_inline|direct (default: hotkey_inline)
                                Uses the hotkey ghost-text path by default.
  --max-retries <n>             Retries for empty-output guard (default: 1)
  --numeric-literal-mismatch-max-retries <n>
                                Retries for numeric-literal mismatch guard (default: 2)
  --semantic-mismatch-max-retries <n>
                                Retries for semantic mismatch guard (default: 2)
  --numeric-literal-guard-enabled <bool>
                                true|false (default: true)
  --semantic-mismatch-guard-enabled <bool>
                                true|false (default: true)
  --rate-limit-window-sec <n>   Rate limit window in seconds (default: 1)
  --rate-limit-max-requests <n> Rate limit max requests (default: 1000)
  --test-pattern <text>         Run only rows whose "test" matches text or /regex/flags
  --log-level <level>           debug|info|warn|error|off (default: info)
  --scope-mode <mode>           file|function (default: file)
  --help                        Show this help
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (parseBooleanFlag(args.help)) {
    printUsage();
    return;
  }
  assertNoRemovedHotkeyBenchmarkArgs(args);

  const workspaceFolder = path.resolve(args.workspace ?? process.cwd());
  const inputFilePath = args['input-file'];
  const contextFileInput = args.file ?? path.join(
    'test_files',
    'python',
    'simple_autocomplete.py',
  );
  const defaultContextFilePath = path.isAbsolute(contextFileInput)
    ? contextFileInput
    : path.join(workspaceFolder, contextFileInput);

  const token = await resolveAuthToken(workspaceFolder, args.token);
  if (!token) {
    throw new Error(
      'Missing bearer token. Set TAB_AUTOCOMPLETE_BEARER_TOKEN, write test/artifacts/oauth_test_token.txt or test_files/oauth_test_token.txt, or set OPENAI_API_KEY.',
    );
  }

  const endpoint = resolveEndpoint(token, args.endpoint ?? process.env.AI_COMPLETION_ENDPOINT);
  const model = args.model ?? process.env.AI_COMPLETION_MODEL ?? DEFAULT_MODEL;
  const instructions = args.instructions ?? DEFAULT_INSTRUCTIONS;
  const languageId = args.language ?? inferLanguageId(defaultContextFilePath);
  const cursorLine = parseInteger(args['cursor-line'], 'cursor-line');
  const cursorChar = parseInteger(args['cursor-char'], 'cursor-char');
  const maxContextLines = parseInteger(args['max-context-lines'], 'max-context-lines') ?? 60;
  const maxFileLines = parseInteger(args['max-file-lines'], 'max-file-lines') ?? 5000;
  const { rateLimitWindowSec, rateLimitMaxRequests } = resolveRateLimitConfig(args);
  const maxOutputTokens = parseInteger(args['max-output-tokens'], 'max-output-tokens');
  const logLevel = args['log-level'] ?? 'info';
  const scopeMode = args['scope-mode'] ?? 'file';
  const testPattern = typeof args['test-pattern'] === 'string'
    ? args['test-pattern'].trim()
    : undefined;
  const serviceTier = args['service-tier'];
  const promptCacheKey = args['prompt-cache-key'];
  const promptCacheRetention = args['prompt-cache-retention'];
  const benchmarkMode = parseBenchmarkMode(args['benchmark-mode']);
  const maxRetries = parseInteger(args['max-retries'], 'max-retries');
  const numericLiteralMismatchMaxRetries = parseInteger(
    args['numeric-literal-mismatch-max-retries'],
    'numeric-literal-mismatch-max-retries',
  );
  const semanticMismatchMaxRetries = parseInteger(
    args['semantic-mismatch-max-retries'],
    'semantic-mismatch-max-retries',
  );
  const numericLiteralGuardEnabled = parseOptionalBooleanFlag(
    args['numeric-literal-guard-enabled'],
    'numeric-literal-guard-enabled',
  );
  const semanticMismatchGuardEnabled = parseOptionalBooleanFlag(
    args['semantic-mismatch-guard-enabled'],
    'semantic-mismatch-guard-enabled',
  );
  if (scopeMode !== 'file' && scopeMode !== 'function') {
    throw new Error(`Invalid --scope-mode: ${scopeMode}. Expected "file" or "function".`);
  }

  setCodexLogLevel(logLevel);

  const provider = createAIProvider(
    {
      async getAccessToken() {
        return token;
      },
    },
    {
      endpoint,
      model,
      instructions,
      rateLimitWindowSec,
      rateLimitMaxRequests,
      maxOutputTokens: maxOutputTokens ?? undefined,
      serviceTier: serviceTier ?? undefined,
      promptCacheKey: promptCacheKey ?? undefined,
      promptCacheRetention: promptCacheRetention ?? undefined,
    },
  );

  const output = {
    appendLine(line) {
      console.log(`[bulk-test] ${line}`);
    },
  };

  console.log(`[bulk-test] workspace=${workspaceFolder}`);
  if (inputFilePath) {
    console.log(`[bulk-test] input_file=${path.resolve(workspaceFolder, inputFilePath)}`);
  }
  console.log(`[bulk-test] default_context_file=${defaultContextFilePath}`);
  console.log(`[bulk-test] language=${languageId} endpoint=${endpoint} model=${model}`);
  console.log(`[bulk-test] benchmark_mode=${benchmarkMode}`);
  if (testPattern) {
    console.log(`[bulk-test] test_pattern=${testPattern}`);
  }

  await runAutocompleteBulkTest({
    workspaceFolder,
    output,
    provider,
    languageId,
    filePath: defaultContextFilePath,
    instructions,
    maxOutputTokens: maxOutputTokens ?? undefined,
    serviceTier: serviceTier ?? undefined,
    promptCacheKey: promptCacheKey ?? undefined,
    promptCacheRetention: promptCacheRetention ?? undefined,
    benchmarkMode,
    maxRetries: maxRetries ?? undefined,
    numericLiteralMismatchMaxRetries: numericLiteralMismatchMaxRetries ?? undefined,
    semanticMismatchMaxRetries: semanticMismatchMaxRetries ?? undefined,
    numericLiteralGuardEnabled: numericLiteralGuardEnabled ?? undefined,
    semanticMismatchGuardEnabled: semanticMismatchGuardEnabled ?? undefined,
    testPattern: testPattern || undefined,
    inputFilePath: inputFilePath || undefined,
    buildContext: () => buildContextString({
      contextFilePath: defaultContextFilePath,
      languageId,
      cursorLineOneBased: cursorLine,
      cursorCharOneBased: cursorChar,
      maxContextLines,
      maxFileLines,
    }),
    buildContextForRow: (row) => buildContextStringForRow({
      row,
      workspaceFolder,
      defaultContextFilePath,
      defaultLanguageId: languageId,
      defaultCursorLine: cursorLine,
      defaultCursorChar: cursorChar,
      maxContextLines,
      maxFileLines,
      scopeMode,
    }),
  });
}

if (require.main === module) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[bulk-test] failed: ${message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  parseInteger,
  parseBooleanFlag,
  parseOptionalBooleanFlag,
  parseBenchmarkMode,
  assertNoRemovedHotkeyBenchmarkArgs,
  resolveRateLimitConfig,
  inferLanguageId,
  resolveEndpoint,
  resolveAuthToken,
  buildContextStringFromText,
};
