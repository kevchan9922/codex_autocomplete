#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createAIProvider } = require('../out/api/providerFactory.js');
const { runAutocompleteResponseTimeTest } = require('../out/debug/responseTimeRunner.js');
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
const DEFAULT_BENCHMARK_MODE = 'hotkey_inline';
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
    const token = argv[index];
    if (!token.startsWith('--')) {
      continue;
    }

    const withoutPrefix = token.slice(2);
    const equalIndex = withoutPrefix.indexOf('=');
    if (equalIndex >= 0) {
      args[withoutPrefix.slice(0, equalIndex)] = withoutPrefix.slice(equalIndex + 1);
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

function parseBooleanFlag(value) {
  if (value === undefined) {
    return false;
  }
  const normalized = String(value).trim().toLowerCase();
  return normalized === '' || normalized === '1' || normalized === 'true' || normalized === 'yes';
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

function normalizeBenchmarkMode(value) {
  if (value === undefined) {
    return DEFAULT_BENCHMARK_MODE;
  }
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'hotkey_inline' || normalized === 'automatic_direct') {
    return normalized;
  }
  throw new Error(
    `Invalid --benchmark-mode: ${value}. Expected "hotkey_inline" or "automatic_direct".`,
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

function resolveInputFilePath(workspaceFolder, inputFile) {
  const inputFileValue = inputFile || path.join('test_files', 'response_time_test_input.json');
  return path.isAbsolute(inputFileValue)
    ? inputFileValue
    : path.join(workspaceFolder, inputFileValue);
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

  return buildRuntimeAlignedContextStringFromText({
    text: source,
    filePath: contextFilePath,
    languageId,
    cursorLineOneBased: cursorLineOneBased ?? defaultCursorLine,
    cursorCharOneBased: cursorCharOneBased ?? defaultCursorChar,
    maxContextLines,
    maxFileLines,
  });
}

function printUsage() {
  console.log(`Run response-time benchmark from terminal (no Extension Development Host).

Usage:
  npm run response:test:cli -- [options]

Required auth:
  - Set TAB_AUTOCOMPLETE_BEARER_TOKEN, or
  - Write a token to test/artifacts/oauth_test_token.txt, or
  - Write a token to test_files/oauth_test_token.txt, or
  - Set OPENAI_API_KEY

Options:
  --workspace <path>            Workspace root (default: current directory)
  --file <path>                 Context source file path relative to workspace
                                (default: test_files/python/simple_autocomplete.py)
  --input-file <path>           Response-time test input JSON
                                (default: test_files/response_time_test_input.json)
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
  --benchmark-mode <mode>       hotkey_inline|automatic_direct (default: hotkey_inline)
                                Uses the hotkey ghost-text path by default.
  --max-context-lines <n>       Max context lines before cursor (default: 60)
  --max-file-lines <n>          Max file lines for context build (default: 5000)
  --rate-limit-window-sec <n>   Rate limit window in seconds (default: 1)
  --rate-limit-max-requests <n> Rate limit max requests (default: 1000)
  --log-level <level>           debug|info|warn|error|off (default: info)
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
  const inputFilePath = resolveInputFilePath(workspaceFolder, args['input-file']);
  const contextFileInput = args.file ?? path.join(
    'test_files',
    'python',
    'simple_autocomplete.py',
  );
  const contextFilePath = path.isAbsolute(contextFileInput)
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
  const languageId = args.language ?? inferLanguageId(contextFilePath);
  const cursorLine = parseInteger(args['cursor-line'], 'cursor-line');
  const cursorChar = parseInteger(args['cursor-char'], 'cursor-char');
  const maxContextLines = parseInteger(args['max-context-lines'], 'max-context-lines') ?? 60;
  const maxFileLines = parseInteger(args['max-file-lines'], 'max-file-lines') ?? 5000;
  const { rateLimitWindowSec, rateLimitMaxRequests } = resolveRateLimitConfig(args);
  const maxOutputTokens = parseInteger(args['max-output-tokens'], 'max-output-tokens');
  const logLevel = args['log-level'] ?? 'info';
  const serviceTier = args['service-tier'];
  const promptCacheKey = args['prompt-cache-key'];
  const promptCacheRetention = args['prompt-cache-retention'];
  const benchmarkMode = normalizeBenchmarkMode(args['benchmark-mode']);

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
      console.log(`[response-time] ${line}`);
    },
  };

  console.log(`[response-time] workspace=${workspaceFolder}`);
  console.log(`[response-time] input_file=${inputFilePath}`);
  console.log(`[response-time] context_file=${contextFilePath}`);
  console.log(
    `[response-time] language=${languageId} endpoint=${endpoint} model=${model} benchmark_mode=${benchmarkMode}`,
  );

  await runAutocompleteResponseTimeTest({
    workspaceFolder,
    output,
    provider,
    languageId,
    filePath: contextFilePath,
    model,
    endpoint,
    instructions,
    maxOutputTokens: maxOutputTokens ?? undefined,
    serviceTier: serviceTier ?? undefined,
    promptCacheKey: promptCacheKey ?? undefined,
    promptCacheRetention: promptCacheRetention ?? undefined,
    benchmarkMode,
    inputFilePath,
    buildContext: () => buildContextString({
      contextFilePath,
      languageId,
      cursorLineOneBased: cursorLine,
      cursorCharOneBased: cursorChar,
      maxContextLines,
      maxFileLines,
    }),
    buildContextForRow: (row) => buildContextStringForRow({
      row,
      workspaceFolder,
      defaultContextFilePath: contextFilePath,
      defaultLanguageId: languageId,
      defaultCursorLine: cursorLine,
      defaultCursorChar: cursorChar,
      maxContextLines,
      maxFileLines,
    }),
  });

  console.log(`[response-time] artifact_dir=${path.join(workspaceFolder, 'test_artifacts')}`);
}

if (require.main === module) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[response-time] failed: ${message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  parseInteger,
  normalizeBenchmarkMode,
  assertNoRemovedHotkeyBenchmarkArgs,
  resolveRateLimitConfig,
  inferLanguageId,
  resolveEndpoint,
  resolveAuthToken,
  resolveInputFilePath,
  buildContextStringFromText,
};
