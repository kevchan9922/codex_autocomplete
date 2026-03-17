#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

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

function parseBooleanFlag(value) {
  if (value === undefined) {
    return false;
  }
  const normalized = String(value).trim().toLowerCase();
  return normalized === '' || normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function parseInteger(value, name, fallback) {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid --${name}: ${value}`);
  }
  return parsed;
}

function printUsage() {
  console.log(`Run end-to-end bulk autocomplete CLI workflow.

Usage:
  npm run bulk:test:quick -- [options]

Options:
  --workspace <path>     Workspace root (default: current directory)
  --max-mismatches <n>   Max mismatch rows in analyzer output (default: 20)
  --mode <name>          strict|tolerant scoring mode (default: strict)
  --skip-show            Skip column display step
  --skip-analyze         Skip analyzer step
  --fail-on-row-mismatch Exit non-zero when input/output row counts differ
  --help                 Show this help
`);
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? process.cwd(),
    stdio: 'inherit',
    env: options.env ?? process.env,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Command failed (${result.status}): ${command} ${args.join(' ')}`);
  }
}

async function findLatestBulkCsv(workspaceFolder) {
  const artifactDirs = [
    path.join(workspaceFolder, 'test_artifacts'),
    path.join(workspaceFolder, 'test_files'),
  ];
  const candidates = [];
  for (const artifactDir of artifactDirs) {
    try {
      const entries = await fs.readdir(artifactDir);
      for (const name of entries) {
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
  withStats.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return withStats[0].filePath;
}

async function readInputRowCount(workspaceFolder) {
  const inputPath = path.join(workspaceFolder, 'test_files', 'autocomplete_test_input.json');
  const raw = await fs.readFile(inputPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`Input JSON must be an array: ${inputPath}`);
  }
  return parsed.length;
}

async function readOutputRowCount(csvPath) {
  const raw = await fs.readFile(csvPath, 'utf8');
  if (!raw.trim()) {
    return 0;
  }
  const rows = parseCsv(raw);
  if (rows.length <= 1) {
    return 0;
  }
  return rows.slice(1).filter((row) => row.some((cell) => String(cell ?? '').length > 0)).length;
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

function evaluateRowCountParity(inputRows, outputRows, failOnMismatch) {
  const mismatch = inputRows !== outputRows;
  if (!mismatch) {
    return {
      mismatch: false,
      statusLine: '[bulk-test:quick] row count parity check passed',
      shouldFail: false,
    };
  }
  return {
    mismatch: true,
    statusLine: failOnMismatch
      ? '[bulk-test:quick] error: row count mismatch between input and output'
      : '[bulk-test:quick] warning: row count mismatch between input and output',
    shouldFail: failOnMismatch,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (parseBooleanFlag(args.help)) {
    printUsage();
    return;
  }

  const workspaceFolder = path.resolve(args.workspace ?? process.cwd());
  const maxMismatches = parseInteger(args['max-mismatches'], 'max-mismatches', 20);
  const mode = String(args.mode ?? 'strict');
  const skipShow = parseBooleanFlag(args['skip-show']);
  const skipAnalyze = parseBooleanFlag(args['skip-analyze']);
  const failOnRowMismatch = parseBooleanFlag(args['fail-on-row-mismatch']);

  console.log(`[bulk-test:quick] workspace=${workspaceFolder}`);

  runCommand(
    npmCommand(),
    ['run', 'bulk:test:cli', '--', '--workspace', workspaceFolder],
    { cwd: workspaceFolder },
  );

  const latestCsv = await findLatestBulkCsv(workspaceFolder);
  console.log(`[bulk-test:quick] latest_output=${latestCsv}`);

  if (!skipShow) {
    runCommand(
      npmCommand(),
      ['run', 'bulk:test:show', '--', '--file', latestCsv, '--mode', mode],
      { cwd: workspaceFolder },
    );
  }

  if (!skipAnalyze) {
    runCommand(
      npmCommand(),
      [
        'run',
        'bulk:test:analyze',
        '--',
        '--file',
        latestCsv,
        '--max-mismatches',
        String(maxMismatches),
        '--mode',
        mode,
      ],
      { cwd: workspaceFolder },
    );
  }

  const [inputRows, outputRows] = await Promise.all([
    readInputRowCount(workspaceFolder),
    readOutputRowCount(latestCsv),
  ]);
  console.log(`[bulk-test:quick] input_rows=${inputRows} output_rows=${outputRows}`);
  const parity = evaluateRowCountParity(inputRows, outputRows, failOnRowMismatch);
  if (parity.mismatch) {
    console.log(parity.statusLine);
    if (parity.shouldFail) {
      throw new Error('row count mismatch between input and output');
    }
  } else {
    console.log(parity.statusLine);
  }
}

if (require.main === module) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[bulk-test:quick] failed: ${message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  parseCsv,
  readOutputRowCount,
  evaluateRowCountParity,
};
