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

function printUsage() {
  console.log(`Compare the latest two comparable response-time runs.

Usage:
  npm run response:test:compare-last -- [options]

Options:
  --workspace <path>              Workspace root (default: current directory)
  --file <path>                   Explicit response_time_history.csv path
  --test-pattern <text>           Filter rows by test name text or /regex/flags
  --fail-on-dataset-mismatch      Exit 2 if compared runs have different test sets
  --fail-on-parity-mismatch       Exit 3 if compared runs have endpoint/model/mode mismatch
  --help                          Show this help
`);
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

function buildTestPatternMatcher(pattern) {
  const trimmed = String(pattern ?? '').trim();
  if (!trimmed) {
    return undefined;
  }

  const regexLiteral = parseRegexLiteral(trimmed);
  if (regexLiteral) {
    const safeFlags = regexLiteral.flags.replace(/[gy]/g, '');
    let regex;
    try {
      regex = new RegExp(regexLiteral.source, safeFlags);
    } catch {
      return undefined;
    }
    return {
      label: `/${regexLiteral.source}/${safeFlags}`,
      match(testName) {
        return regex.test(testName);
      },
    };
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
        record[header[index]] = row[index] ?? '';
      }
      return record;
    });
}

async function findHistoryPath(workspaceFolder, explicitFile) {
  if (explicitFile) {
    return path.resolve(explicitFile);
  }

  const candidates = [
    path.join(workspaceFolder, 'test_artifacts', 'response_time_history.csv'),
    path.join(workspaceFolder, 'test_files', 'response_time_history.csv'),
    path.join(workspaceFolder, 'response_time_history.csv'),
  ];

  const existing = [];
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      existing.push({ path: candidate, mtimeMs: stat.mtimeMs });
    } catch (err) {
      const code = err && typeof err === 'object' ? err.code : undefined;
      if (code !== 'ENOENT') {
        throw err;
      }
    }
  }

  if (existing.length === 0) {
    throw new Error(
      `No response-time history file found. Checked: ${candidates.join(', ')}`,
    );
  }

  existing.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return existing[0].path;
}

function parseMs(value) {
  const text = String(value ?? '').trim();
  if (!text || text.toLowerCase() === 'n/a') {
    return undefined;
  }
  const parsed = Number.parseFloat(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function percentile(sortedValues, ratio) {
  if (sortedValues.length === 0) {
    return undefined;
  }
  if (sortedValues.length === 1) {
    return sortedValues[0];
  }
  const rawIndex = (sortedValues.length - 1) * ratio;
  const lower = Math.floor(rawIndex);
  const upper = Math.ceil(rawIndex);
  if (lower === upper) {
    return sortedValues[lower];
  }
  const weight = rawIndex - lower;
  return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * weight;
}

function summarizeMs(values) {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    avg: total / sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
  };
}

function summarizeRun(rows) {
  const successRows = rows.filter((row) => String(row.status).trim() === 'success');
  const firstChunkValues = successRows
    .map((row) => parseMs(row.first_chunk_ms))
    .filter((value) => value !== undefined);
  const totalDurationValues = successRows
    .map((row) => parseMs(row.total_duration_ms))
    .filter((value) => value !== undefined);
  const successCount = rows.filter((row) => String(row.status).trim() === 'success').length;
  const emptyCount = rows.filter((row) => String(row.status).trim() === 'empty').length;
  const errorCount = rows.filter((row) => String(row.status).trim() === 'error').length;
  const scoredExactMatchRows = rows.filter((row) => isScoredExactMatchRow(row));
  const matchCount = scoredExactMatchRows
    .filter((row) => String(row.match_target_output).trim() === 'true')
    .length;
  const nonScoredCount = rows.length - scoredExactMatchRows.length;

  return {
    totalRows: rows.length,
    scoredMatchRows: scoredExactMatchRows.length,
    nonScoredCount,
    successCount,
    emptyCount,
    errorCount,
    matchCount,
    successRate: rows.length === 0 ? 0 : successCount / rows.length,
    firstChunk: summarizeMs(firstChunkValues),
    totalDuration: summarizeMs(totalDurationValues),
  };
}

function hasComparableLatencyRows(rows) {
  return rows.some((row) => {
    const status = String(row.status).trim();
    if (status !== 'success') {
      return false;
    }
    return parseMs(row.first_chunk_ms) !== undefined
      && parseMs(row.total_duration_ms) !== undefined;
  });
}

function formatNumber(value) {
  if (value === undefined || !Number.isFinite(value)) {
    return 'n/a';
  }
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function formatMsSummary(summary) {
  if (!summary) {
    return 'avg=n/a p50=n/a p95=n/a n=0';
  }
  return `avg=${formatNumber(summary.avg)} p50=${formatNumber(summary.p50)} p95=${formatNumber(summary.p95)} n=${summary.count}`;
}

function formatDelta(currentValue, previousValue) {
  if (currentValue === undefined || previousValue === undefined) {
    return 'n/a';
  }
  const delta = currentValue - previousValue;
  const formatted = formatNumber(delta);
  if (formatted === 'n/a') {
    return formatted;
  }
  return delta > 0 ? `+${formatted}` : formatted;
}

function toFiniteNumber(value) {
  return Number.isFinite(value) ? value : undefined;
}

function printRunSummary(label, runId, summary) {
  console.log(`${label}_run=${runId}`);
  console.log(
    `${label}_status=success:${summary.successCount} empty:${summary.emptyCount} error:${summary.errorCount} match:${summary.matchCount}/${summary.scoredMatchRows} non_scored:${summary.nonScoredCount} success_rate=${formatNumber(summary.successRate * 100)}%`,
  );
  console.log(`${label}_first_chunk_ms ${formatMsSummary(summary.firstChunk)}`);
  console.log(`${label}_total_duration_ms ${formatMsSummary(summary.totalDuration)}`);
}

function isScoredExactMatchRow(row) {
  const value = String(row.match_target_output ?? '').trim();
  return value === 'true' || value === 'false';
}

function summarizeDataset(leftRows, rightRows) {
  const leftSet = new Set(
    leftRows
      .map((row) => String(row.test ?? '').trim())
      .filter((value) => value.length > 0),
  );
  const rightSet = new Set(
    rightRows
      .map((row) => String(row.test ?? '').trim())
      .filter((value) => value.length > 0),
  );

  const leftOnly = [...leftSet].filter((value) => !rightSet.has(value)).sort();
  const rightOnly = [...rightSet].filter((value) => !leftSet.has(value)).sort();
  const overlapCount = [...leftSet].filter((value) => rightSet.has(value)).length;

  return {
    leftCount: leftSet.size,
    rightCount: rightSet.size,
    overlapCount,
    leftOnly,
    rightOnly,
    mismatch: leftOnly.length > 0 || rightOnly.length > 0,
  };
}

function summarizeParity(previousRows, latestRows) {
  const previous = summarizeRunParity(previousRows);
  const latest = summarizeRunParity(latestRows);

  return {
    previous,
    latest,
    mismatch:
      previous.endpoint !== latest.endpoint
      || previous.model !== latest.model
      || previous.benchmarkMode !== latest.benchmarkMode,
  };
}

function summarizeRunParity(rows) {
  return {
    endpoint: summarizeParityField(rows, 'endpoint', '<unknown-endpoint>'),
    model: summarizeParityField(rows, 'model', '<unknown-model>'),
    benchmarkMode: summarizeParityField(
      rows,
      'benchmark_mode',
      'automatic_direct',
    ),
  };
}

function summarizeParityField(rows, fieldName, fallbackValue) {
  const uniqueValues = [
    ...new Set(
      rows
        .map((row) => String(row[fieldName] ?? '').trim())
        .map((value) => (value.length > 0 ? value : fallbackValue)),
    ),
  ];
  if (uniqueValues.length === 0) {
    return fallbackValue;
  }
  if (uniqueValues.length === 1) {
    return uniqueValues[0];
  }
  return `[mixed:${uniqueValues.join('|')}]`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (parseBooleanFlag(args.help)) {
    printUsage();
    return;
  }

  const failOnDatasetMismatch = parseBooleanFlag(args['fail-on-dataset-mismatch']);
  const failOnParityMismatch = parseBooleanFlag(args['fail-on-parity-mismatch']);
  const workspaceFolder = path.resolve(args.workspace ?? process.cwd());
  const historyPath = await findHistoryPath(workspaceFolder, args.file);
  const content = await fs.readFile(historyPath, 'utf8');
  const rows = parseCsv(content);
  let records = toRecords(rows);

  if (typeof args['test-pattern'] === 'string' && args['test-pattern'].trim().length > 0) {
    const matcher = buildTestPatternMatcher(args['test-pattern']);
    if (!matcher) {
      throw new Error(
        `Invalid --test-pattern (${args['test-pattern']}). Use plain text or /regex/flags.`,
      );
    }
    const beforeCount = records.length;
    records = records.filter((record) => matcher.match(String(record.test ?? '').trim()));
    console.log(`test_pattern=${matcher.label}`);
    console.log(`test_pattern_rows=${records.length}/${beforeCount}`);
  }

  const byRunId = new Map();
  for (const record of records) {
    const runId = String(record.run_id ?? '').trim();
    if (!runId) {
      continue;
    }
    const bucket = byRunId.get(runId) ?? [];
    bucket.push(record);
    byRunId.set(runId, bucket);
  }

  const runIds = [...byRunId.keys()].sort();
  console.log(`response_time_history_file=${historyPath}`);
  console.log(`runs_detected=${runIds.length}`);
  const comparableRunIds = runIds.filter((runId) =>
    hasComparableLatencyRows(byRunId.get(runId) ?? []),
  );
  console.log(`comparable_runs_detected=${comparableRunIds.length}`);

  if (runIds.length === 0) {
    console.log('insufficient_comparable_runs=0 need_at_least=2');
    return;
  }

  const latestOverallRunId = runIds[runIds.length - 1];
  const latestOverallSummary = summarizeRun(byRunId.get(latestOverallRunId) ?? []);
  printRunSummary('latest_overall', latestOverallRunId, latestOverallSummary);

  if (comparableRunIds.length < 2) {
    if (comparableRunIds.length === 1) {
      const onlyComparableRunId = comparableRunIds[0];
      const onlyComparableSummary = summarizeRun(byRunId.get(onlyComparableRunId) ?? []);
      printRunSummary('latest_comparable', onlyComparableRunId, onlyComparableSummary);
    }
    console.log(`insufficient_comparable_runs=${comparableRunIds.length} need_at_least=2`);
    console.log('compare_hint=record at least two runs with status=success and numeric first_chunk_ms');
    return;
  }

  const latestRunId = comparableRunIds[comparableRunIds.length - 1];
  const previousRunId = comparableRunIds[comparableRunIds.length - 2];
  const latestRows = byRunId.get(latestRunId) ?? [];
  const previousRows = byRunId.get(previousRunId) ?? [];
  const datasetSummary = summarizeDataset(previousRows, latestRows);
  const paritySummary = summarizeParity(previousRows, latestRows);
  const latestSummary = summarizeRun(byRunId.get(latestRunId) ?? []);
  const previousSummary = summarizeRun(byRunId.get(previousRunId) ?? []);

  if (latestRunId !== latestOverallRunId) {
    console.log(`latest_overall_run_skipped=${latestOverallRunId} reason=no_comparable_latency_rows`);
  }
  console.log(`previous_dataset_tests=${datasetSummary.leftCount}`);
  console.log(`latest_dataset_tests=${datasetSummary.rightCount}`);
  console.log(`dataset_overlap_tests=${datasetSummary.overlapCount}`);
  if (datasetSummary.mismatch) {
    console.log('dataset_mismatch=true');
    console.log(`dataset_previous_only=${datasetSummary.leftOnly.length}`);
    console.log(`dataset_latest_only=${datasetSummary.rightOnly.length}`);
    if (datasetSummary.leftOnly.length > 0) {
      console.log(`dataset_previous_only_samples=${datasetSummary.leftOnly.slice(0, 5).join(' | ')}`);
    }
    if (datasetSummary.rightOnly.length > 0) {
      console.log(`dataset_latest_only_samples=${datasetSummary.rightOnly.slice(0, 5).join(' | ')}`);
    }
    if (failOnDatasetMismatch) {
      console.log('dataset_mismatch_mode=fail');
      process.exitCode = 2;
      return;
    }
    console.log('dataset_mismatch_mode=warn');
  } else {
    console.log('dataset_mismatch=false');
  }
  if (paritySummary.mismatch) {
    console.log('parity_mismatch=true');
    console.log(`parity_previous_endpoint=${paritySummary.previous.endpoint}`);
    console.log(`parity_latest_endpoint=${paritySummary.latest.endpoint}`);
    console.log(`parity_previous_model=${paritySummary.previous.model}`);
    console.log(`parity_latest_model=${paritySummary.latest.model}`);
    console.log(`parity_previous_benchmark_mode=${paritySummary.previous.benchmarkMode}`);
    console.log(`parity_latest_benchmark_mode=${paritySummary.latest.benchmarkMode}`);
    if (failOnParityMismatch) {
      console.log('parity_mismatch_mode=fail');
      process.exitCode = 3;
      return;
    }
    console.log('parity_mismatch_mode=warn');
  } else {
    console.log('parity_mismatch=false');
  }
  printRunSummary('previous', previousRunId, previousSummary);
  printRunSummary('latest', latestRunId, latestSummary);
  console.log(`delta_first_chunk_avg_ms=${formatDelta(latestSummary.firstChunk?.avg, previousSummary.firstChunk?.avg)}`);
  console.log(`delta_total_duration_avg_ms=${formatDelta(latestSummary.totalDuration?.avg, previousSummary.totalDuration?.avg)}`);
  console.log(`delta_success_rate_pp=${formatDelta(latestSummary.successRate * 100, previousSummary.successRate * 100)}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[response-time:compare] failed: ${message}`);
  process.exitCode = 1;
});
