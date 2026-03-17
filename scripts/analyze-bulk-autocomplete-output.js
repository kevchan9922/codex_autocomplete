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

function parseBoolean(value) {
  if (value === undefined) {
    return false;
  }
  const normalized = String(value).trim().toLowerCase();
  return normalized === '' || normalized === '1' || normalized === 'true' || normalized === 'yes';
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

function escapeCsvCell(value) {
  const text = String(value ?? '');
  const escaped = text.replace(/"/g, '""');
  return /[",\n]/.test(text) ? `"${escaped}"` : escaped;
}

function formatTimestamp(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
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

  const outputHasEscaped = outputRaw.includes('\\"') || outputRaw.includes('\\n');
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

function extractStringLiteralValues(value) {
  const matches = String(value ?? '').matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g);
  return Array.from(matches, (match) => match[1] ?? match[2] ?? match[3] ?? '');
}

function hasStringLiteralDrift(targetRaw, outputRaw) {
  const targetLiterals = extractStringLiteralValues(targetRaw);
  const outputLiterals = extractStringLiteralValues(outputRaw);
  if (targetLiterals.length === 0 && outputLiterals.length === 0) {
    return false;
  }
  if (targetLiterals.length !== outputLiterals.length) {
    return true;
  }
  for (let index = 0; index < targetLiterals.length; index += 1) {
    if (targetLiterals[index] !== outputLiterals[index]) {
      return true;
    }
  }
  return false;
}

function normalizeWithoutPunctuation(value) {
  return normalizeForComparison(value)
    .replace(/[^\w"']+/g, '')
    .toLowerCase();
}

function isPunctuationOnlyDifference(targetRaw, outputRaw) {
  const target = normalizeForComparison(targetRaw);
  const output = normalizeForComparison(outputRaw);
  if (!target || !output || target === output) {
    return false;
  }
  if (hasStringLiteralDrift(targetRaw, outputRaw)) {
    return false;
  }
  return normalizeWithoutPunctuation(target) === normalizeWithoutPunctuation(output);
}

function classifyFailureClass(row) {
  if (row.status !== 'fail') {
    return '';
  }

  if (row.reason === 'numeric_value_drift') {
    return 'semantic_drift';
  }

  if (isPunctuationOnlyDifference(row.target_output ?? '', row.output ?? '')) {
    return 'punctuation_drift';
  }

  return 'semantic_drift';
}

function maskNumbers(value) {
  return String(value ?? '').replace(/-?\d+(?:\.\d+)?/g, '<num>');
}

function inferSuiteFromTestName(testName) {
  const test = String(testName ?? '').trim();
  return test.startsWith('PAT-') ? 'pat' : 'core';
}

function inferLanguageFromRow(row) {
  const test = String(row.test ?? '');
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
    case '.go':
      return 'go';
    case '.rs':
      return 'rust';
    case '.cs':
      return 'csharp';
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

function isSemicolonToleranceLanguage(languageId) {
  return isTypeScriptLike(languageId) || languageId === 'csharp';
}

function normalizeOptionalSemicolon(value) {
  const normalized = normalizeForComparison(value);
  return normalized.endsWith(';') ? normalized.slice(0, -1).trimEnd() : normalized;
}

function evaluateOptionalSemicolon(targetRaw, outputRaw, languageId) {
  if (!isSemicolonToleranceLanguage(languageId)) {
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

function evaluateTypeScriptObjectKeyOrderEquivalent(targetRaw, outputRaw, languageId) {
  if (!isTypeScriptLike(languageId)) {
    return false;
  }
  const target = normalizeForComparison(targetRaw);
  const output = normalizeForComparison(outputRaw);
  if (!target || !output || target === output) {
    return false;
  }

  const targetObject = parseTopLevelObjectLiteral(target);
  const outputObject = parseTopLevelObjectLiteral(output);
  if (!targetObject || !outputObject) {
    return false;
  }

  if (targetObject.prefix !== outputObject.prefix || targetObject.suffix !== outputObject.suffix) {
    return false;
  }

  const targetEntries = parseObjectEntries(targetObject.inner);
  const outputEntries = parseObjectEntries(outputObject.inner);
  if (!targetEntries || !outputEntries || targetEntries.length !== outputEntries.length) {
    return false;
  }

  const targetMap = new Map(targetEntries);
  if (targetMap.size !== targetEntries.length) {
    return false;
  }
  for (const [key, value] of outputEntries) {
    if (!targetMap.has(key) || targetMap.get(key) !== value) {
      return false;
    }
  }

  const targetOrder = targetEntries.map(([key]) => key).join(',');
  const outputOrder = outputEntries.map(([key]) => key).join(',');
  return targetOrder !== outputOrder;
}

function parseTopLevelObjectLiteral(value) {
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let escapeNext = false;
  let start = -1;
  let depth = 0;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (char === '\\') {
      escapeNext = true;
      continue;
    }
    if (inSingle) {
      if (char === '\'') {
        inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      if (char === '"') {
        inDouble = false;
      }
      continue;
    }
    if (inTemplate) {
      if (char === '`') {
        inTemplate = false;
      }
      continue;
    }
    if (char === '\'') {
      inSingle = true;
      continue;
    }
    if (char === '"') {
      inDouble = true;
      continue;
    }
    if (char === '`') {
      inTemplate = true;
      continue;
    }

    if (char === '{') {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
      continue;
    }

    if (char === '}') {
      if (depth === 0) {
        return undefined;
      }
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const prefix = value.slice(0, start).trim();
        const suffix = value.slice(index + 1).trim();
        return {
          prefix,
          inner: value.slice(start + 1, index),
          suffix,
        };
      }
      continue;
    }
  }

  return undefined;
}

function parseObjectEntries(inner) {
  const parts = splitTopLevelByComma(inner);
  if (parts.length === 0) {
    return [];
  }
  const entries = [];
  for (const part of parts) {
    const colonIndex = findTopLevelChar(part, ':');
    if (colonIndex < 0) {
      return undefined;
    }
    const rawKey = part.slice(0, colonIndex).trim();
    const rawValue = part.slice(colonIndex + 1).trim();
    if (!rawKey || !rawValue) {
      return undefined;
    }
    const key = stripWrappingQuotes(rawKey);
    const value = normalizeForComparison(rawValue);
    entries.push([key, value]);
  }
  return entries;
}

function evaluatePythonKwargReorderEquivalent(targetRaw, outputRaw, languageId) {
  if (languageId !== 'python') {
    return false;
  }
  const target = normalizeForComparison(targetRaw);
  const output = normalizeForComparison(outputRaw);
  if (!target || !output || target === output) {
    return false;
  }

  const targetKwargs = parsePythonKeywordArguments(target);
  const outputKwargs = parsePythonKeywordArguments(output);
  if (!targetKwargs || !outputKwargs) {
    return false;
  }
  if (targetKwargs.length !== outputKwargs.length || targetKwargs.length < 2) {
    return false;
  }

  const targetMap = new Map(targetKwargs);
  if (targetMap.size !== targetKwargs.length) {
    return false;
  }
  for (const [key, value] of outputKwargs) {
    if (!targetMap.has(key) || targetMap.get(key) !== value) {
      return false;
    }
  }

  const targetOrder = targetKwargs.map(([key]) => key).join(',');
  const outputOrder = outputKwargs.map(([key]) => key).join(',');
  return targetOrder !== outputOrder;
}

function parsePythonKeywordArguments(value) {
  const closeParen = value.indexOf(')');
  if (closeParen < 0) {
    return undefined;
  }
  const argsText = value.slice(0, closeParen).trim();
  if (!argsText) {
    return undefined;
  }

  const parts = splitTopLevelByComma(argsText);
  if (parts.length === 0) {
    return undefined;
  }

  const kwargs = [];
  for (const part of parts) {
    const equalIndex = findTopLevelChar(part, '=');
    if (equalIndex < 0) {
      return undefined;
    }
    const key = part.slice(0, equalIndex).trim();
    const rawValue = part.slice(equalIndex + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || !rawValue) {
      return undefined;
    }
    kwargs.push([key, normalizeForComparison(rawValue)]);
  }
  return kwargs;
}

function findTopLevelChar(value, targetChar) {
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let escapeNext = false;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (char === '\\') {
      escapeNext = true;
      continue;
    }
    if (inSingle) {
      if (char === '\'') {
        inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      if (char === '"') {
        inDouble = false;
      }
      continue;
    }
    if (inTemplate) {
      if (char === '`') {
        inTemplate = false;
      }
      continue;
    }
    if (char === '\'') {
      inSingle = true;
      continue;
    }
    if (char === '"') {
      inDouble = true;
      continue;
    }
    if (char === '`') {
      inTemplate = true;
      continue;
    }
    if (char === '(') {
      parenDepth += 1;
      continue;
    }
    if (char === ')') {
      parenDepth = Math.max(0, parenDepth - 1);
      continue;
    }
    if (char === '[') {
      bracketDepth += 1;
      continue;
    }
    if (char === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1);
      continue;
    }
    if (char === '{') {
      braceDepth += 1;
      continue;
    }
    if (char === '}') {
      braceDepth = Math.max(0, braceDepth - 1);
      continue;
    }
    if (char === targetChar && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      return index;
    }
  }
  return -1;
}

function splitTopLevelByComma(value) {
  const parts = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let escapeNext = false;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (escapeNext) {
      current += char;
      escapeNext = false;
      continue;
    }
    if (char === '\\') {
      current += char;
      escapeNext = true;
      continue;
    }
    if (inSingle) {
      current += char;
      if (char === '\'') {
        inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      current += char;
      if (char === '"') {
        inDouble = false;
      }
      continue;
    }
    if (inTemplate) {
      current += char;
      if (char === '`') {
        inTemplate = false;
      }
      continue;
    }
    if (char === '\'') {
      inSingle = true;
      current += char;
      continue;
    }
    if (char === '"') {
      inDouble = true;
      current += char;
      continue;
    }
    if (char === '`') {
      inTemplate = true;
      current += char;
      continue;
    }
    if (char === '(') {
      parenDepth += 1;
      current += char;
      continue;
    }
    if (char === ')') {
      parenDepth = Math.max(0, parenDepth - 1);
      current += char;
      continue;
    }
    if (char === '[') {
      bracketDepth += 1;
      current += char;
      continue;
    }
    if (char === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1);
      current += char;
      continue;
    }
    if (char === '{') {
      braceDepth += 1;
      current += char;
      continue;
    }
    if (char === '}') {
      braceDepth = Math.max(0, braceDepth - 1);
      current += char;
      continue;
    }
    if (char === ',' && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      const token = current.trim();
      if (token.length > 0) {
        parts.push(token);
      }
      current = '';
      continue;
    }
    current += char;
  }

  const trailing = current.trim();
  if (trailing.length > 0) {
    parts.push(trailing);
  }
  return parts;
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

  if (evaluateOptionalSemicolon(targetRaw, outputRaw, languageId)) {
    return 'tolerant_semicolon_optional';
  }

  if (evaluateTypeScriptObjectKeyOrderEquivalent(targetRaw, outputRaw, languageId)) {
    return 'tolerant_object_key_order';
  }

  if (evaluatePythonKwargReorderEquivalent(targetRaw, outputRaw, languageId)) {
    return 'tolerant_python_kwarg_reorder';
  }

  return undefined;
}

function evaluateRow(row, mode = 'strict') {
  const target = row.target_output ?? '';
  const output = row.output ?? '';
  const normalizedTarget = normalizeForComparison(target);
  const normalizedOutput = normalizeForComparison(output);
  const isScenarioDependent = normalizedTarget === '<scenario-dependent>';
  const exactMatch = target === output;
  const normalizedMatch = normalizedTarget.length > 0 && normalizedTarget === normalizedOutput;

  if (isScenarioDependent) {
    return {
      status: 'scenario',
      reason: 'scenario_dependent_manual_review',
      exactMatch: false,
      normalizedMatch: false,
      isScenarioDependent: true,
    };
  }

  if (exactMatch) {
    return {
      status: 'pass_exact',
      reason: 'exact_match',
      exactMatch: true,
      normalizedMatch: true,
      isScenarioDependent: false,
    };
  }

  if (normalizedMatch) {
    return {
      status: 'pass_normalized',
      reason: 'normalized_match',
      exactMatch: false,
      normalizedMatch: true,
      isScenarioDependent: false,
    };
  }

  if (mode === 'tolerant') {
    const tolerantReason = evaluateTolerantMatch(target, output, row.inferredLanguageId);
    if (tolerantReason) {
      return {
        status: 'pass_tolerant',
        reason: tolerantReason,
        exactMatch: false,
        normalizedMatch: false,
        isScenarioDependent: false,
      };
    }
  }

  return {
    status: 'fail',
    reason: classifyMismatch(target, output),
    exactMatch: false,
    normalizedMatch: false,
    isScenarioDependent: false,
  };
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

function printUsage() {
  console.log(`Analyze bulk autocomplete output quality.

Usage:
  node scripts/analyze-bulk-autocomplete-output.js [options]
  npm run bulk:test:analyze

Options:
  --file <path>          Specific CSV file (default: latest in test_artifacts/, fallback: test_files/)
  --workspace <path>     Workspace root (default: current directory)
  --test-pattern <text>  Filter rows by test name text or /regex/flags
  --max-mismatches <n>   Max mismatch rows printed in console (default: 20)
  --mode <name>          strict|tolerant scoring mode (default: strict)
  --no-write             Do not write analysis CSV artifact
  --out <path>           Explicit output analysis CSV path
  --fail-on-mismatch     Exit non-zero when at least one scored row fails
  --fail-on-empty-output Exit non-zero when at least one row has empty output
  --help                 Show this help
`);
}

function toRecords(rows) {
  if (rows.length === 0) {
    return [];
  }
  const header = rows[0];
  return rows.slice(1)
    .filter((row) => row.some((cell) => String(cell ?? '').length > 0))
    .map((row) => {
      const record = {};
      for (let index = 0; index < header.length; index += 1) {
        const key = header[index];
        record[key] = row[index] ?? '';
      }
      return record;
    });
}

function truncate(value, maxLength) {
  if (value.length <= maxLength) {
    return value;
  }
  if (maxLength <= 3) {
    return '.'.repeat(maxLength);
  }
  return `${value.slice(0, maxLength - 3)}...`;
}

function summarizeRows(rows) {
  const scenarioRows = rows.filter((row) => row.isScenarioDependent);
  const scoredRows = rows.filter((row) => !row.isScenarioDependent);
  const exactPassRows = scoredRows.filter((row) => row.status === 'pass_exact');
  const normalizedPassOnlyRows = scoredRows.filter((row) => row.status === 'pass_normalized');
  const tolerantPassRows = scoredRows.filter((row) => row.status === 'pass_tolerant');
  const failRows = scoredRows.filter((row) => row.status === 'fail');
  const semanticFailRows = failRows.filter((row) => row.failureClass === 'semantic_drift');
  const punctuationFailRows = failRows.filter((row) => row.failureClass === 'punctuation_drift');

  const passExactRate = scoredRows.length === 0 ? 0 : (exactPassRows.length / scoredRows.length);
  const passNormalizedRate = scoredRows.length === 0
    ? 0
    : ((exactPassRows.length + normalizedPassOnlyRows.length) / scoredRows.length);
  const passEffectiveRate = scoredRows.length === 0
    ? 0
    : ((exactPassRows.length + normalizedPassOnlyRows.length + tolerantPassRows.length) / scoredRows.length);

  return {
    totalRows: rows.length,
    scenarioRows,
    scoredRows,
    exactPassRows,
    normalizedPassOnlyRows,
    tolerantPassRows,
    failRows,
    semanticFailRows,
    punctuationFailRows,
    passExactRate,
    passNormalizedRate,
    passEffectiveRate,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (parseBoolean(args.help)) {
    printUsage();
    return;
  }

  const workspaceFolder = path.resolve(args.workspace ?? process.cwd());
  const csvPath = args.file
    ? path.resolve(args.file)
    : await findLatestBulkCsv(workspaceFolder);
  const maxMismatches = parseIntArg(args['max-mismatches'], 'max-mismatches', 20);
  const mode = parseMode(args.mode ?? 'strict');
  const shouldWrite = !parseBoolean(args['no-write']);
  const failOnMismatch = parseBoolean(args['fail-on-mismatch']);
  const failOnEmptyOutput = parseBoolean(args['fail-on-empty-output']);
  const testPattern = typeof args['test-pattern'] === 'string'
    ? args['test-pattern'].trim()
    : undefined;

  const content = await fs.readFile(csvPath, 'utf8');
  const parsedRows = parseCsv(content);
  if (parsedRows.length === 0) {
    throw new Error(`CSV is empty: ${csvPath}`);
  }
  let records = toRecords(parsedRows);
  if (records.length === 0) {
    throw new Error(`CSV has no data rows: ${csvPath}`);
  }

  let testPatternLabel;
  let testPatternRowsSummary;
  if (testPattern) {
    const matcher = buildTestPatternMatcher(testPattern);
    if (!matcher) {
      throw new Error(`Invalid --test-pattern (${testPattern}). Use plain text or /regex/flags.`);
    }
    const beforeCount = records.length;
    records = records.filter((row) => matcher.match(String(row.test ?? '')));
    testPatternLabel = matcher.label;
    testPatternRowsSummary = `${records.length}/${beforeCount}`;
  }

  const evaluatedRows = records.map((row, index) => {
    const suite = inferSuiteFromTestName(row.test);
    const inferredLanguageId = inferLanguageFromRow(row);
    const evaluation = evaluateRow(
      {
        ...row,
        inferredLanguageId,
      },
      mode,
    );
    return {
      index: index + 1,
      ...row,
      suite,
      inferredLanguageId,
      ...evaluation,
      failureClass: '',
      targetLength: String(row.target_output ?? '').length,
      outputLength: String(row.output ?? '').length,
      mode,
    };
  });
  for (const row of evaluatedRows) {
    row.failureClass = classifyFailureClass(row);
  }

  const summary = summarizeRows(evaluatedRows);
  const emptyOutputRows = evaluatedRows.filter((row) => String(row.output ?? '').trim().length === 0);
  const scenarioRows = summary.scenarioRows;
  const scoredRows = summary.scoredRows;
  const exactPassRows = summary.exactPassRows;
  const normalizedPassOnlyRows = summary.normalizedPassOnlyRows;
  const tolerantPassRows = summary.tolerantPassRows;
  const failRows = summary.failRows;
  const semanticFailRows = summary.semanticFailRows;
  const punctuationFailRows = summary.punctuationFailRows;

  const reasonCounts = new Map();
  for (const row of evaluatedRows) {
    reasonCounts.set(row.reason, (reasonCounts.get(row.reason) ?? 0) + 1);
  }

  const sortedReasons = [...reasonCounts.entries()].sort((left, right) => right[1] - left[1]);

  console.log(`file: ${csvPath}`);
  console.log(`mode=${mode}`);
  if (testPatternLabel) {
    console.log(`test_pattern=${testPatternLabel}`);
    console.log(`test_pattern_rows=${testPatternRowsSummary}`);
  }
  console.log(`total_rows=${evaluatedRows.length}`);
  console.log(`scored_rows=${scoredRows.length}`);
  console.log(`scenario_rows=${scenarioRows.length}`);
  console.log(`exact_matches=${exactPassRows.length}`);
  console.log(`normalized_only_matches=${normalizedPassOnlyRows.length}`);
  console.log(`tolerant_matches=${tolerantPassRows.length}`);
  console.log(`failures=${failRows.length}`);
  console.log(`empty_outputs=${emptyOutputRows.length}`);
  console.log(`semantic_failures=${semanticFailRows.length}`);
  console.log(`punctuation_failures=${punctuationFailRows.length}`);
  console.log(`pass_rate_exact=${(summary.passExactRate * 100).toFixed(1)}%`);
  console.log(`pass_rate_normalized=${(summary.passNormalizedRate * 100).toFixed(1)}%`);
  console.log(`pass_rate_effective=${(summary.passEffectiveRate * 100).toFixed(1)}%`);

  const suiteGroups = new Map();
  for (const row of evaluatedRows) {
    const bucket = suiteGroups.get(row.suite) ?? [];
    bucket.push(row);
    suiteGroups.set(row.suite, bucket);
  }
  console.log('\nsuite_breakdown:');
  for (const suiteName of ['core', 'pat']) {
    const suiteRows = suiteGroups.get(suiteName) ?? [];
    if (suiteRows.length === 0) {
      continue;
    }
    const suiteSummary = summarizeRows(suiteRows);
    console.log(
      `- suite=${suiteName} total_rows=${suiteSummary.totalRows} scored_rows=${suiteSummary.scoredRows.length} exact_matches=${suiteSummary.exactPassRows.length} normalized_only_matches=${suiteSummary.normalizedPassOnlyRows.length} tolerant_matches=${suiteSummary.tolerantPassRows.length} failures=${suiteSummary.failRows.length} semantic_failures=${suiteSummary.semanticFailRows.length} punctuation_failures=${suiteSummary.punctuationFailRows.length} pass_rate_exact=${(suiteSummary.passExactRate * 100).toFixed(1)}% pass_rate_effective=${(suiteSummary.passEffectiveRate * 100).toFixed(1)}%`,
    );
  }

  console.log('\nfailure_class_breakdown:');
  console.log(`- semantic_drift: ${semanticFailRows.length}`);
  console.log(`- punctuation_drift: ${punctuationFailRows.length}`);

  console.log('\nreason_breakdown:');
  for (const [reason, count] of sortedReasons) {
    console.log(`- ${reason}: ${count}`);
  }

  const mismatchesToPrint = failRows.slice(0, maxMismatches);
  if (mismatchesToPrint.length > 0) {
    console.log(`\nmismatch_samples (showing ${mismatchesToPrint.length}/${failRows.length}):`);
    for (const row of mismatchesToPrint) {
      const target = truncate(String(row.target_output ?? '').replace(/\r?\n/g, '\\n'), 40);
      const output = truncate(String(row.output ?? '').replace(/\r?\n/g, '\\n'), 80);
      console.log(
        `- row=${row.index} reason=${row.reason} | target=${JSON.stringify(target)} | output=${JSON.stringify(output)}`,
      );
    }
  }

  let analysisPath = args.out ? path.resolve(args.out) : undefined;
  if (shouldWrite) {
    if (!analysisPath) {
      analysisPath = path.join(
        workspaceFolder,
        'test_artifacts',
        `autocomplete_test_analysis_${mode}_${formatTimestamp(new Date())}.csv`,
      );
    }
    await fs.mkdir(path.dirname(analysisPath), { recursive: true });
    const header = [
      'index',
      'test',
      'target_output',
      'output',
      'match_exact',
      'match_normalized',
      'is_scenario_dependent',
      'status',
      'reason',
      'failure_class',
      'suite',
      'inferred_language_id',
      'target_length',
      'output_length',
      'scoring_mode',
    ];
    const lines = [header.join(',')];
    for (const row of evaluatedRows) {
      lines.push([
        row.index,
        row.test ?? '',
        row.target_output ?? '',
        row.output ?? '',
        row.exactMatch ? 'true' : 'false',
        row.normalizedMatch ? 'true' : 'false',
        row.isScenarioDependent ? 'true' : 'false',
        row.status,
        row.reason,
        row.failureClass,
        row.suite ?? '',
        row.inferredLanguageId ?? '',
        row.targetLength,
        row.outputLength,
        row.mode,
      ].map(escapeCsvCell).join(','));
    }
    await fs.writeFile(analysisPath, `${lines.join('\n')}\n`, 'utf8');
    console.log(`\nanalysis_csv=${analysisPath}`);
  }

  if (failOnMismatch && failRows.length > 0) {
    process.exitCode = 2;
  }
  if (failOnEmptyOutput && emptyOutputRows.length > 0) {
    process.exitCode = 3;
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[bulk-test:analyze] failed: ${message}`);
  process.exitCode = 1;
});
