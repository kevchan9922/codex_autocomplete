#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const SETTINGS_PREFIX = 'codexAutocomplete.';

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
      assignArg(args, key, value);
      continue;
    }

    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      assignArg(args, withoutPrefix, next);
      index += 1;
      continue;
    }

    assignArg(args, withoutPrefix, 'true');
  }
  return args;
}

function assignArg(args, key, value) {
  if (args[key] === undefined) {
    args[key] = value;
    return;
  }

  if (Array.isArray(args[key])) {
    args[key].push(value);
    return;
  }

  args[key] = [args[key], value];
}

function getArgList(args, key) {
  if (args[key] === undefined) {
    return [];
  }
  return Array.isArray(args[key]) ? args[key] : [args[key]];
}

function parseBool(value) {
  if (value === undefined) {
    return false;
  }
  const normalized = String(value).trim().toLowerCase();
  return normalized === '' || normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function getDefaultUserSettingsPath(platform = process.platform, homeDir = os.homedir()) {
  if (platform === 'darwin') {
    return path.join(homeDir, 'Library', 'Application Support', 'Code', 'User', 'settings.json');
  }
  if (platform === 'win32') {
    const appData = process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
    return path.join(appData, 'Code', 'User', 'settings.json');
  }
  return path.join(homeDir, '.config', 'Code', 'User', 'settings.json');
}

function getContributedSettingKeys(extensionRoot = path.resolve(__dirname, '..')) {
  // Source keys from the extension manifest so the script stays aligned with package.json.
  const packageJson = require(path.join(extensionRoot, 'package.json'));
  const properties = packageJson?.contributes?.configuration?.properties || {};
  return Object.keys(properties).filter((key) => key.startsWith(SETTINGS_PREFIX)).sort();
}

function stripJsonComments(text) {
  let output = '';
  let inString = false;
  let stringQuote = '';
  let isEscaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (inLineComment) {
      if (char === '\n') {
        inLineComment = false;
        output += char;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }

    if (inString) {
      output += char;
      if (isEscaped) {
        isEscaped = false;
      } else if (char === '\\') {
        isEscaped = true;
      } else if (char === stringQuote) {
        inString = false;
        stringQuote = '';
      }
      continue;
    }

    if (char === '/' && next === '/') {
      inLineComment = true;
      index += 1;
      continue;
    }

    if (char === '/' && next === '*') {
      inBlockComment = true;
      index += 1;
      continue;
    }

    if (char === '"' || char === '\'') {
      inString = true;
      stringQuote = char;
    }

    output += char;
  }

  return output;
}

function removeTrailingCommas(text) {
  let output = '';
  let inString = false;
  let stringQuote = '';
  let isEscaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      output += char;
      if (isEscaped) {
        isEscaped = false;
      } else if (char === '\\') {
        isEscaped = true;
      } else if (char === stringQuote) {
        inString = false;
        stringQuote = '';
      }
      continue;
    }

    if (char === '"' || char === '\'') {
      inString = true;
      stringQuote = char;
      output += char;
      continue;
    }

    if (char === ',') {
      let lookahead = index + 1;
      while (lookahead < text.length && /\s/.test(text[lookahead])) {
        lookahead += 1;
      }
      if (text[lookahead] === '}' || text[lookahead] === ']') {
        continue;
      }
    }

    output += char;
  }

  return output;
}

function parseJsoncObject(text) {
  const normalized = removeTrailingCommas(stripJsonComments(text)).trim();
  if (!normalized) {
    return {};
  }
  const parsed = JSON.parse(normalized);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Expected a top-level JSON object.');
  }
  return parsed;
}

function removeSettingsKeys(settings, keys) {
  let removedCount = 0;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(settings, key)) {
      continue;
    }
    delete settings[key];
    removedCount += 1;
  }
  return removedCount;
}

async function updateSettingsFile(filePath, keys, dryRun = false) {
  let text;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { filePath, exists: false, removedCount: 0, changed: false };
    }
    throw error;
  }

  const settings = parseJsoncObject(text);
  const removedCount = removeSettingsKeys(settings, keys);
  if (removedCount === 0) {
    return { filePath, exists: true, removedCount: 0, changed: false };
  }

  if (!dryRun) {
    const serialized = `${JSON.stringify(settings, null, 2)}\n`;
    await fs.writeFile(filePath, serialized, 'utf8');
  }

  return { filePath, exists: true, removedCount, changed: true };
}

function resolveTargetFiles(args, cwd = process.cwd()) {
  const explicitFiles = getArgList(args, 'file').map((entry) => path.resolve(cwd, entry));
  if (explicitFiles.length > 0) {
    return [...new Set(explicitFiles)];
  }

  const targets = [];
  const includeUser = args.user === undefined ? true : parseBool(args.user);
  const includeWorkspace = args.workspace === undefined ? true : parseBool(args.workspace);

  if (includeUser) {
    targets.push(getDefaultUserSettingsPath());
  }

  if (includeWorkspace) {
    targets.push(path.resolve(cwd, '.vscode', 'settings.json'));
  }

  return [...new Set(targets)];
}

function formatResult(result) {
  if (!result.exists) {
    return `skip ${result.filePath} (not found)`;
  }
  if (!result.changed) {
    return `ok   ${result.filePath} (no Codex Autocomplete settings found)`;
  }
  return `done ${result.filePath} (removed ${result.removedCount} setting${result.removedCount === 1 ? '' : 's'})`;
}

function printUsage() {
  console.log(`Clear Codex Autocomplete settings from VS Code settings files.

Usage:
  node scripts/clear-codex-autocomplete-settings.js [options]

Options:
  --file <path>         Clear one or more specific settings.json files
  --user <bool>         Include the VS Code user settings file (default: true)
  --workspace <bool>    Include .vscode/settings.json in the current workspace (default: true)
  --dry-run             Show what would change without writing files
  --help                Show this help
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (parseBool(args.help)) {
    printUsage();
    return;
  }

  const dryRun = parseBool(args['dry-run']);
  const keys = getContributedSettingKeys();
  const targets = resolveTargetFiles(args);

  if (targets.length === 0) {
    throw new Error('No target settings files resolved.');
  }

  const results = [];
  for (const target of targets) {
    results.push(await updateSettingsFile(target, keys, dryRun));
  }

  for (const result of results) {
    console.log(formatResult(result));
  }

  const removedTotal = results.reduce((sum, result) => sum + result.removedCount, 0);
  console.log(
    dryRun
      ? `dry-run complete: ${removedTotal} Codex Autocomplete setting${removedTotal === 1 ? '' : 's'} would be removed`
      : `complete: removed ${removedTotal} Codex Autocomplete setting${removedTotal === 1 ? '' : 's'}`,
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  getContributedSettingKeys,
  getDefaultUserSettingsPath,
  parseArgs,
  parseJsoncObject,
  removeSettingsKeys,
  resolveTargetFiles,
  stripJsonComments,
  removeTrailingCommas,
  updateSettingsFile,
};
