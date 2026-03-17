require('./helpers/registerVscode.js');

const test = require('node:test');
const assert = require('node:assert/strict');
const vscode = require('vscode');

const {
  getDebugOutputChannel,
  resetDebugOutputChannelForTests,
  DEBUG_OUTPUT_CHANNEL_NAME,
} = require('../out/debug/outputChannel.js');

test('getDebugOutputChannel reuses a singleton output channel instance', () => {
  resetDebugOutputChannelForTests();

  const originalCreate = vscode.window.createOutputChannel;
  let createCalls = 0;
  const createdChannels = [];

  vscode.window.createOutputChannel = (name) => {
    createCalls += 1;
    assert.equal(name, DEBUG_OUTPUT_CHANNEL_NAME);
    const channel = { appendLine() {}, clear() {}, show() {} };
    createdChannels.push(channel);
    return channel;
  };

  try {
    const first = getDebugOutputChannel();
    const second = getDebugOutputChannel();

    assert.equal(createCalls, 1);
    assert.equal(first, second);
    assert.equal(first, createdChannels[0]);
  } finally {
    vscode.window.createOutputChannel = originalCreate;
    resetDebugOutputChannelForTests();
  }
});
