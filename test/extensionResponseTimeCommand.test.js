require('./helpers/registerVscode.js');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');

const { activate } = require('../out/extension.js');

function createSecretStorage() {
  const data = new Map();
  return {
    async get(key) {
      return data.get(key);
    },
    async store(key, value) {
      data.set(key, value);
    },
    async delete(key) {
      data.delete(key);
    },
  };
}

async function appendHistoryToRepoArtifact(header, rows) {
  if (rows.length === 0) {
    return;
  }

  const artifactDir = path.join(process.cwd(), 'test_artifacts');
  const artifactPath = path.join(artifactDir, 'response_time_history.csv');
  await fs.mkdir(artifactDir, { recursive: true });

  try {
    const existing = await fs.readFile(artifactPath, 'utf8');
    const existingHeader = existing.split('\n')[0];
    if (existingHeader !== header) {
      await fs.writeFile(artifactPath, `${header}\n`, 'utf8');
    }
  } catch (err) {
    const code = err && typeof err === 'object' ? err.code : undefined;
    if (code === 'ENOENT') {
      await fs.writeFile(artifactPath, `${header}\n`, 'utf8');
    } else {
      throw err;
    }
  }

  await fs.appendFile(artifactPath, `${rows.join('\n')}\n`, 'utf8');
}

function parseCsvLine(line) {
  const cells = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      cells.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  cells.push(current);
  return cells;
}

test('Codex Autocomplete: Debug response time test command is runnable via npm test suite', async () => {
  const workspaceFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-autocomplete-ext-rt-'));
  const inputDir = path.join(workspaceFolder, 'test_files');
  await fs.mkdir(inputDir, { recursive: true });
  await fs.writeFile(
    path.join(inputDir, 'autocomplete_test_input.json'),
    JSON.stringify([{ test: 'PY-1 | command smoke', target_output: '"Mina")' }], null, 2),
    'utf8',
  );

  const testFilePath = path.join(workspaceFolder, 'manual_test.py');
  await fs.writeFile(testFilePath, 'def demo() -> None:\n    print("hello")\n', 'utf8');

  vscode.workspace.workspaceFolders = [{ uri: { fsPath: workspaceFolder } }];
  vscode.window.activeTextEditor = {
    document: {
      languageId: 'python',
      uri: { fsPath: testFilePath },
      getText(arg) {
        if (arg) {
          return '';
        }
        return 'def demo() -> None:\n    print("hello")\n';
      },
    },
    selection: {
      active: {
        line: 1,
        character: 4,
      },
    },
  };

  const extensionContext = {
    secrets: createSecretStorage(),
    subscriptions: [],
  };

  await activate(extensionContext);
  await vscode.commands.executeCommand('codexAutocomplete.debugResponseTimeTest');

  const historyPath = path.join(workspaceFolder, 'test_artifacts', 'response_time_history.csv');
  const historyCsv = await fs.readFile(historyPath, 'utf8');
  const lines = historyCsv.trimEnd().split('\n');

  assert.equal(lines.length, 2);
  assert.equal(
    lines[0],
    'run_id,run_started_at,test,target_output,first_chunk_ms,total_duration_ms,status,match_target_output,output_length,language_id,file_path,model,endpoint,context_char_count,instructions_char_count,input_chars_est,input_tokens_est,benchmark_mode,prefix_chars,suffix_chars,extra_context_chars,scenario_chars,constraint_chars,before_lines_count,headers_latency_ms,first_raw_chunk_ms,first_payload_ms,first_text_ms,stream_duration_ms,server_processing_ms,request_id,row_tags,pre_attempt_ms,hotkey_press_to_accept_ms',
  );
  assert.match(historyCsv, /PY-1 \| command smoke/);
  assert.match(historyCsv, /python/);
  await appendHistoryToRepoArtifact(lines[0], lines.slice(1));

  const row = parseCsvLine(lines[1]);
  const firstChunkMs = row[4] || 'n/a';
  const totalDurationMs = row[5] || 'n/a';
  const status = row[6] || 'unknown';
  assert.equal(row[17], 'hotkey_inline');
  const hotkeyAcceptMs = row[33] || 'n/a';
  console.log(
    `[response-time][npm-test] test="${row[2]}" first_chunk_ms=${firstChunkMs} total_duration_ms=${totalDurationMs} hotkey_press_to_accept_ms=${hotkeyAcceptMs} status=${status}`,
  );

  for (const disposable of extensionContext.subscriptions) {
    disposable.dispose?.();
  }
});
