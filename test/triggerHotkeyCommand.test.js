require('./helpers/registerVscode.js');

const test = require('node:test');
const assert = require('node:assert/strict');
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

test('triggerHotkey shows generating message and forwards the inline suggest command', async () => {
  const extensionContext = {
    secrets: createSecretStorage(),
    subscriptions: [],
  };
  await extensionContext.secrets.store(
    'tabAutocomplete.tokens',
    JSON.stringify({ accessToken: 'access-1' }),
  );

  vscode.window.activeTextEditor = {
    document: {
      languageId: 'python',
      uri: { fsPath: '/tmp/manual-hotkey.py' },
      getText() {
        return '';
      },
    },
    selection: {
      active: {
        line: 0,
        character: 0,
      },
    },
  };

  const originalWithProgress = vscode.window.withProgress;
  const seenMessages = [];
  const seenCommands = [];
  vscode.window.withProgress = async (options, task) => {
    seenMessages.push(options);
    return task();
  };

  const inlineSuggestDisposable = vscode.commands.registerCommand(
    'editor.action.inlineSuggest.trigger',
    async () => {
      seenCommands.push('editor.action.inlineSuggest.trigger');
    },
  );

  try {
    await activate(extensionContext);
    await vscode.commands.executeCommand('codexAutocomplete.triggerHotkey');
  } finally {
    vscode.window.withProgress = originalWithProgress;
    inlineSuggestDisposable.dispose();
    for (const disposable of extensionContext.subscriptions) {
      disposable.dispose?.();
    }
  }

  assert.equal(seenMessages.length, 1);
  assert.equal(seenMessages[0].location, vscode.ProgressLocation.Notification);
  assert.equal(seenMessages[0].title, 'Generating suggestion…');
  assert.equal(seenMessages[0].cancellable, false);
  assert.deepEqual(seenCommands, ['editor.action.inlineSuggest.trigger']);
});
