require('./helpers/registerVscode.js');

const test = require('node:test');
const assert = require('node:assert/strict');
const vscode = require('vscode');

const { activate } = require('../out/extension.js');
const { resetDebugOutputChannelForTests } = require('../out/debug/outputChannel.js');

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

test('debugContext reports the same serialized input_text used in request bodies', async () => {
  resetDebugOutputChannelForTests();

  const outputLines = [];
  const originalCreateOutputChannel = vscode.window.createOutputChannel;
  vscode.window.createOutputChannel = () => ({
    appendLine(value) {
      outputLines.push(value);
    },
    clear() {
      outputLines.length = 0;
    },
    show() {},
  });

  vscode.window.activeTextEditor = {
    document: {
      languageId: 'python',
      uri: {
        fsPath: '/tmp/debug-context.py',
        toString() {
          return this.fsPath;
        },
      },
      getText(arg) {
        if (arg) {
          return '';
        }
        return 'def example(name: str) -> str:\n    return na';
      },
    },
    selection: {
      active: {
        line: 1,
        character: 13,
      },
    },
  };

  const extensionContext = {
    secrets: createSecretStorage(),
    subscriptions: [],
  };

  try {
    await activate(extensionContext);
    await vscode.commands.executeCommand('codexAutocomplete.debugContext');
  } finally {
    vscode.window.createOutputChannel = originalCreateOutputChannel;
    resetDebugOutputChannelForTests();
    for (const disposable of extensionContext.subscriptions) {
      disposable.dispose?.();
    }
  }

  const reportMarkerIndex = outputLines.lastIndexOf('[debug-context] request report:');
  assert.notEqual(reportMarkerIndex, -1, 'expected debug context report marker in output channel');
  assert.equal(
    outputLines.some((line) => line.includes('[codex] debug context report chunk=')),
    false,
  );
  assert.equal(
    outputLines.some((line) => line.includes('[codex] debug context report length=')),
    false,
  );

  const reportJson = outputLines[reportMarkerIndex + 1];
  assert.equal(typeof reportJson, 'string', 'expected debug context report JSON in output channel');

  const report = JSON.parse(reportJson);
  const fastBodyText = report.fast_request_body.input[0].content[0].text;
  const fullBodyText = report.full_request_body.input[0].content[0].text;

  assert.deepEqual(report.fast_prompt_payload, JSON.parse(fastBodyText));
  assert.deepEqual(report.full_prompt_payload, JSON.parse(fullBodyText));
  assert.equal(report.fast_prompt_payload.file_path, '/tmp/debug-context.py');
  assert.equal(report.full_prompt_payload.file_path, '/tmp/debug-context.py');
  assert.equal('selection' in report.fast_prompt_payload, false);
  assert.equal('selection' in report.full_prompt_payload, false);
  assert.equal('fast_input_text' in report, false);
  assert.equal('full_input_text' in report, false);
  const reportKeys = Object.keys(report);
  const fastPayloadIndex = reportKeys.indexOf('fast_prompt_payload');
  const fullPayloadIndex = reportKeys.indexOf('full_prompt_payload');
  const fastSummaryIndex = reportKeys.indexOf('fast_request_summary');
  assert.notEqual(fastPayloadIndex, -1);
  assert.notEqual(fullPayloadIndex, -1);
  assert.notEqual(fastSummaryIndex, -1);
  assert.ok(fastPayloadIndex < fastSummaryIndex);
  assert.ok(fullPayloadIndex < fastSummaryIndex);
});
