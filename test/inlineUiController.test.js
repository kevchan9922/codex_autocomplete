require('./helpers/registerVscode.js');

const test = require('node:test');
const assert = require('node:assert/strict');
const vscode = require('vscode');

const { InlineUiController } = require('../out/completion/inlineUiController.js');

test('InlineUiController deduplicates retrigger events by editor/hash window', () => {
  const controller = new InlineUiController();
  const first = controller.shouldRetriggerInline('/tmp/file.py', 'hash-1');
  const second = controller.shouldRetriggerInline('/tmp/file.py', 'hash-1');
  const otherHash = controller.shouldRetriggerInline('/tmp/file.py', 'hash-2');

  assert.equal(first, true);
  assert.equal(second, false);
  assert.equal(otherHash, true);
});

test('InlineUiController throttles empty-response notifications', async () => {
  const controller = new InlineUiController();
  const messages = [];
  const originalShowInfo = vscode.window.showInformationMessage;
  vscode.window.showInformationMessage = async (message) => {
    messages.push(message);
    return undefined;
  };

  try {
    controller.notifyEmptyModelResponse();
    controller.notifyEmptyModelResponse();
  } finally {
    vscode.window.showInformationMessage = originalShowInfo;
  }

  assert.equal(messages.length, 1);
  assert.equal(messages[0], 'No autocomplete - empty response from model');
});

test('InlineUiController throttles first-chunk-timeout notifications', async () => {
  const controller = new InlineUiController();
  const messages = [];
  const originalShowInfo = vscode.window.showInformationMessage;
  vscode.window.showInformationMessage = async (message) => {
    messages.push(message);
    return undefined;
  };

  try {
    controller.notifyFirstChunkTimeout(2200);
    controller.notifyFirstChunkTimeout(2200);
  } finally {
    vscode.window.showInformationMessage = originalShowInfo;
  }

  assert.equal(messages.length, 1);
  assert.equal(messages[0], 'No autocomplete - timed out waiting for first token (2200ms)');
});

test('InlineUiController throttles post-chunk-timeout notifications', async () => {
  const controller = new InlineUiController();
  const messages = [];
  const originalShowInfo = vscode.window.showInformationMessage;
  vscode.window.showInformationMessage = async (message) => {
    messages.push(message);
    return undefined;
  };

  try {
    controller.notifyPostChunkTimeout();
    controller.notifyPostChunkTimeout();
  } finally {
    vscode.window.showInformationMessage = originalShowInfo;
  }

  assert.equal(messages.length, 1);
  assert.equal(messages[0], 'No autocomplete - request timed out before a usable completion was produced');
});

test('InlineUiController shows hotkey-trigger notification', async () => {
  const controller = new InlineUiController();
  const progressCalls = [];
  let disposeCount = 0;
  let progressPromise;
  const originalWithProgress = vscode.window.withProgress;
  vscode.window.withProgress = async (options, task) => {
    progressCalls.push(options);
    progressPromise = Promise.resolve(task()).then(() => {
      disposeCount += 1;
    });
    return progressPromise;
  };

  try {
    controller.notifyHotkeyTriggered();
  } finally {
    controller.dispose();
    await progressPromise;
    vscode.window.withProgress = originalWithProgress;
  }

  assert.equal(progressCalls.length, 1);
  assert.equal(progressCalls[0].location, vscode.ProgressLocation.Notification);
  assert.equal(progressCalls[0].title, 'Generating suggestion…');
  assert.equal(progressCalls[0].cancellable, false);
  assert.equal(disposeCount, 1);
});

test('InlineUiController refreshes progress notification for hotkey retry', async () => {
  const controller = new InlineUiController();
  const progressCalls = [];
  const completions = [];
  const originalWithProgress = vscode.window.withProgress;
  vscode.window.withProgress = async (options, task) => {
    progressCalls.push(options);
    const completion = Promise.resolve(task());
    completions.push(completion);
    return completion;
  };

  try {
    controller.notifyHotkeyTriggered();
    controller.notifyHotkeyRetrying();
  } finally {
    controller.dispose();
    await Promise.allSettled(completions);
    vscode.window.withProgress = originalWithProgress;
  }

  assert.equal(progressCalls.length, 2);
  assert.equal(progressCalls[0].title, 'Generating suggestion…');
  assert.equal(progressCalls[1].title, 'Auto-retrying…');
});

test('InlineUiController clears hotkey-trigger status across controller instances', async () => {
  const triggerController = new InlineUiController();
  const renderController = new InlineUiController();
  let disposeCount = 0;
  let progressPromise;
  const originalWithProgress = vscode.window.withProgress;
  vscode.window.withProgress = async (_options, task) => {
    progressPromise = Promise.resolve(task()).then(() => {
      disposeCount += 1;
    });
    return progressPromise;
  };

  try {
    triggerController.notifyHotkeyTriggered();
    renderController.clearHotkeyTriggered();
    renderController.clearHotkeyTriggered();
  } finally {
    triggerController.dispose();
    renderController.dispose();
    await progressPromise;
    vscode.window.withProgress = originalWithProgress;
  }

  assert.equal(disposeCount, 1);
});
