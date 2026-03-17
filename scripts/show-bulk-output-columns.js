#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

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

function parseIntArg(value, name, defaultValue) {
  if (value === undefined) {
    return defaultValue;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid --${name}: ${value}`);
  }
  return parsed;
}

function parseMode(value) {
  const normalized = String(value ?? 'strict').trim().toLowerCase();
  if (normalized === 'strict' || normalized === 'tolerant') {
    return normalized;
  }
  throw new Error(`Invalid --mode: ${value}. Expected strict or tolerant.`);
}

function buildTestPatternMatcher(pattern) {
  const trimmed = String(pattern ?? '').trim();
  if (!trimmed) {
    return undefined;
  }

  const parsedRegex = parseRegexLiteral(trimmed);
  if (parsedRegex) {
    try {
      const safeFlags = parsedRegex.flags.replace(/[gy]/g, '');
      const regex = new RegExp(parsedRegex.source, safeFlags);
      return {
        label: `/${parsedRegex.source}/${safeFlags}`,
        match(testName) {
          return regex.test(testName);
        },
      };
    } catch {
      return undefined;
    }
  }

  return {
    label: `contains("${trimmed}")`,
    match(testName) {
      return testName.includes(trimmed);
    },
  };
}

function parseRegexLiteral(value) {
  if (!value.startsWith('/')) {
    return undefined;
  }
  const finalSlash = value.lastIndexOf('/');
  if (finalSlash <= 0) {
    return undefined;
  }
  return {
    source: value.slice(1, finalSlash),
    flags: value.slice(finalSlash + 1),
  };
}

function parseCsv(content) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    const next = content[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      row.push(cell);
      cell = '';
      continue;
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') {
        index += 1;
      }
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }

    cell += char;
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows;
}

function normalizeForComparison(value) {
  return unescapeCommonSequences(String(value ?? ''))
    .replace(/\r\n/g, '\n')
    .trim();
}

function unescapeCommonSequences(value) {
  return String(value ?? '')
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\\\/g, '\\');
}

function stripWrappingQuotes(value) {
  const trimmed = String(value ?? '').trim();
  if (trimmed.length < 2) {
    return trimmed;
  }
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function normalizeNumericFormatting(value) {
  return String(value ?? '').replace(/-?\d+(?:\.\d+)?/g, (token) => {
    const parsed = Number.parseFloat(token);
    if (!Number.isFinite(parsed)) {
      return token;
    }
    return String(parsed);
  });
}

function normalizeForSemanticComparison(value) {
  return normalizeNumericFormatting(
    normalizeForComparison(stripWrappingQuotes(unescapeCommonSequences(value)))
      .replace(/[ \t]+/g, ' '),
  );
}

function extractNumbers(value) {
  const matches = String(value ?? '').match(/-?\d+(?:\.\d+)?/g);
  if (!matches) {
    return [];
  }
  return matches.map((token) => Number.parseFloat(token)).filter((token) => Number.isFinite(token));
}

function numbersEqual(left, right, epsilon = 1e-9) {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => Math.abs(value - right[index]) <= epsilon);
}

function numbersClose(left, right, epsilon = 0.02) {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => Math.abs(value - right[index]) <= epsilon);
}

function isIdentifierLike(value) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function classifyMismatch(targetRaw, outputRaw) {
  const target = normalizeForComparison(targetRaw);
  const output = normalizeForComparison(outputRaw);

  if (!output) {
    return 'empty_output';
  }

  const targetNumbers = extractNumbers(target);
  const outputNumbers = extractNumbers(output);
  if (targetNumbers.length > 0 && outputNumbers.length > 0 && !numbersEqual(targetNumbers, outputNumbers)) {
    return 'numeric_value_drift';
  }

  const outputHasEscaped = String(outputRaw).includes('\\"') || String(outputRaw).includes('\\n');
  if (outputHasEscaped) {
    return 'escaped_text_noise';
  }

  const targetShort = target.length > 0 && target.length <= 24;
  const outputHasStatements = /\b(return|const|let|var|def|function|public|static)\b/.test(output);
  if ((output.includes('\n') || outputHasStatements || output.length > target.length + 12) && targetShort) {
    return 'over_completion';
  }

  if (/^[\)\];,]+$/.test(output) && !/^[\)\];,]+$/.test(target)) {
    return 'under_completion_closure_only';
  }

  if (isIdentifierLike(target) && !isIdentifierLike(output)) {
    return 'likely_wrong_symbol_or_context';
  }

  if (target && output && (output.includes(target) || target.includes(output))) {
    return 'partial_overlap';
  }

  return 'mismatch_other';
}

function maskNumbers(value) {
  return String(value ?? '').replace(/-?\d+(?:\.\d+)?/g, '<num>');
}

function inferLanguageFromTestName(testName) {
  const test = String(testName ?? '');
  const filePathMatch = test.match(/\bfile=([^|]+)/i);
  const filePath = filePathMatch ? filePathMatch[1].trim() : '';
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.ts':
    case '.tsx':
      return 'typescript';
    case '.js':
    case '.jsx':
      return 'javascript';
    case '.py':
      return 'python';
    case '.java':
      return 'java';
    default:
      break;
  }

  if (/\bTypeScript\b|(^|\b)TS-/.test(test)) {
    return 'typescript';
  }
  if (/\bJava\b|(^|\b)JV-/.test(test)) {
    return 'java';
  }
  if (/\bPython\b|(^|\b)PY-/.test(test)) {
    return 'python';
  }
  return 'unknown';
}

function isTypeScriptLike(languageId) {
  return languageId === 'typescript' || languageId === 'javascript';
}

function normalizeOptionalSemicolon(value) {
  const normalized = normalizeForComparison(value);
  return normalized.endsWith(';') ? normalized.slice(0, -1).trimEnd() : normalized;
}

function evaluateTypeScriptOptionalSemicolon(targetRaw, outputRaw, languageId) {
  if (!isTypeScriptLike(languageId)) {
    return false;
  }

  const target = normalizeForComparison(targetRaw);
  const output = normalizeForComparison(outputRaw);
  if (!target || !output || target === output) {
    return false;
  }

  const targetBase = normalizeOptionalSemicolon(target);
  const outputBase = normalizeOptionalSemicolon(output);
  if (targetBase !== outputBase) {
    return false;
  }

  const targetHasSemicolon = target.endsWith(';');
  const outputHasSemicolon = output.endsWith(';');
  return targetHasSemicolon !== outputHasSemicolon;
}

function evaluateTolerantMatch(targetRaw, outputRaw, languageId) {
  const target = normalizeForSemanticComparison(targetRaw);
  const output = normalizeForSemanticComparison(outputRaw);
  if (!target || !output) {
    return undefined;
  }

  if (target === output) {
    return 'tolerant_semantic_match';
  }

  const targetNumbers = extractNumbers(target);
  const outputNumbers = extractNumbers(output);
  const sameNumberShape = maskNumbers(target) === maskNumbers(output);
  if (
    targetNumbers.length > 0
    && outputNumbers.length > 0
    && sameNumberShape
    && numbersClose(targetNumbers, outputNumbers)
  ) {
    return 'tolerant_numeric_close';
  }

  if (evaluateTypeScriptOptionalSemicolon(targetRaw, outputRaw, languageId)) {
    return 'tolerant_ts_semicolon_optional';
  }

  return undefined;
}

function evaluateRow(targetOutput, output, mode = 'strict', testName = '') {
  const target = String(targetOutput ?? '');
  const actual = String(output ?? '');
  const normalizedTarget = normalizeForComparison(target);
  const normalizedOutput = normalizeForComparison(actual);
  const languageId = inferLanguageFromTestName(testName);

  if (normalizedTarget === '<scenario-dependent>') {
    return {
      status: 'scenario',
      reason: 'scenario_dependent_manual_review',
    };
  }

  if (target === actual) {
    return {
      status: 'pass_exact',
      reason: 'exact_match',
    };
  }

  if (normalizedTarget.length > 0 && normalizedTarget === normalizedOutput) {
    return {
      status: 'pass_normalized',
      reason: 'normalized_match',
    };
  }

  if (mode === 'tolerant') {
    const tolerantReason = evaluateTolerantMatch(target, actual, languageId);
    if (tolerantReason) {
      return {
        status: 'pass_tolerant',
        reason: tolerantReason,
      };
    }
  }

  return {
    status: 'fail',
    reason: classifyMismatch(target, actual),
  };
}

function printUsage() {
  console.log(`Show target_output/output plus quality columns from bulk autocomplete CSV.

Usage:
  node scripts/show-bulk-output-columns.js [options]
  npm run bulk:test:show

Options:
  --file <path>      Specific CSV file path (default: latest in test_artifacts/, fallback: test_files/)
  --workspace <path> Workspace root (default: current directory)
  --test-pattern <text>
                     Filter rows by test name text or /regex/flags
  --test-width <n>   test column width (default: 64)
  --width <n>        target_output column width (default: 40)
  --output-width <n> output column width (default: 70)
  --mode <name>      strict|tolerant scoring mode (default: strict)
  --help             Show this help
`);
}

function truncate(value, width) {
  if (value.length <= width) {
    return value;
  }
  if (width <= 3) {
    return '.'.repeat(width);
  }
  return `${value.slice(0, width - 3)}...`;
}

async function findLatestBulkCsv(workspaceFolder) {
  const artifactDirs = [
    path.join(workspaceFolder, 'test_artifacts'),
    path.join(workspaceFolder, 'test_files'),
  ];
  const candidates = [];
  for (const artifactDir of artifactDirs) {
    try {
      const files = await fs.readdir(artifactDir);
      for (const name of files) {
        if (/^autocomplete_test_output_.*\.csv$/.test(name)) {
          candidates.push(path.join(artifactDir, name));
        }
      }
    } catch (err) {
      if (err && typeof err === 'object' && err.code === 'ENOENT') {
        continue;
      }
      throw err;
    }
  }

  if (candidates.length === 0) {
    throw new Error(
      `No autocomplete_test_output_*.csv files found in ${artifactDirs.join(' or ')}`,
    );
  }

  const withStats = await Promise.all(
    candidates.map(async (filePath) => ({
      filePath,
      mtimeMs: (await fs.stat(filePath)).mtimeMs,
    })),
  );
  withStats.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return withStats[0].filePath;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help === 'true' || args.help === true) {
    printUsage();
    return;
  }

  const workspaceFolder = path.resolve(args.workspace ?? process.cwd());
  const testWidth = parseIntArg(args['test-width'], 'test-width', 64);
  const width = parseIntArg(args.width, 'width', 40);
  const outputWidth = parseIntArg(args['output-width'], 'output-width', 70);
  const mode = parseMode(args.mode ?? 'strict');
  const testPattern = typeof args['test-pattern'] === 'string'
    ? args['test-pattern'].trim()
    : undefined;
  const csvPath = args.file
    ? path.resolve(args.file)
    : await findLatestBulkCsv(workspaceFolder);

  const content = await fs.readFile(csvPath, 'utf8');
  const rows = parseCsv(content);
  if (rows.length === 0) {
    throw new Error(`CSV is empty: ${csvPath}`);
  }

  const header = rows[0];
  const testIndex = header.indexOf('test');
  const targetIndex = header.indexOf('target_output');
  const outputIndex = header.indexOf('output');
  if (testIndex < 0 || targetIndex < 0 || outputIndex < 0) {
    throw new Error('CSV must include test, target_output, and output columns');
  }

  let dataRows = rows.slice(1).filter((row) => row && row.length > 0);
  if (testPattern) {
    const matcher = buildTestPatternMatcher(testPattern);
    if (!matcher) {
      throw new Error(`Invalid --test-pattern (${testPattern}). Use plain text or /regex/flags.`);
    }
    const beforeCount = dataRows.length;
    dataRows = dataRows.filter((row) => matcher.match(String(row[testIndex] ?? '')));
    console.log(`test_pattern=${matcher.label}`);
    console.log(`test_pattern_rows=${dataRows.length}/${beforeCount}`);
  }

  const separatorLength = testWidth + 3 + width + 3 + outputWidth + 3 + 16 + 3 + 32 + 3 + 13 + 3 + 13;
  console.log(`file: ${csvPath}`);
  console.log(`mode: ${mode}`);
  console.log(
    `${'test'.padEnd(testWidth)} | ${'target_output'.padEnd(width)} | ${'output'.padEnd(outputWidth)} | ${'status'.padEnd(16)} | ${'reason'.padEnd(32)} | ${'target_length'.padStart(13)} | ${'output_length'.padStart(13)}`,
  );
  console.log('-'.repeat(separatorLength));

  for (const row of dataRows) {
    const targetOriginal = row[targetIndex] ?? '';
    const outputOriginal = row[outputIndex] ?? '';
    const testName = row[testIndex] ?? '';
    const testRaw = String(testName).replace(/\r?\n/g, '\\n');
    const targetRaw = String(targetOriginal).replace(/\r?\n/g, '\\n');
    const outputRaw = String(outputOriginal).replace(/\r?\n/g, '\\n');
    const evaluation = evaluateRow(targetOriginal, outputOriginal, mode, testName);
    const test = truncate(testRaw, testWidth);
    const target = truncate(targetRaw, width);
    const output = truncate(outputRaw, outputWidth);
    console.log(
      `${test.padEnd(testWidth)} | ${target.padEnd(width)} | ${output.padEnd(outputWidth)} | ${evaluation.status.padEnd(16)} | ${evaluation.reason.padEnd(32)} | ${String(targetOriginal.length).padStart(13)} | ${String(outputOriginal.length).padStart(13)}`,
    );
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[bulk-test:show] failed: ${message}`);
  process.exitCode = 1;
});
