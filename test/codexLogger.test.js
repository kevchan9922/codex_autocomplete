const test = require('node:test');
const assert = require('node:assert/strict');

const {
  codexDebug,
  codexError,
  codexInfo,
  getCodexLogLevel,
  getCodexLogStatsSnapshot,
  setCodexLogLevel,
} = require('../out/logging/codexLogger.js');

test('codexLogger respects configured log level', () => {
  const previousLevel = getCodexLogLevel();
  const captured = [];
  const originalLog = console.log;
  console.log = (message) => captured.push(message);

  try {
    setCodexLogLevel('error');
    codexInfo('info-message');
    codexError('error-message');
  } finally {
    setCodexLogLevel(previousLevel);
    console.log = originalLog;
  }

  assert.equal(captured.length, 1);
  assert.match(captured[0], /\[ERROR\]/);
  assert.match(captured[0], /error-message/);
});

test('codexLogger redacts bearer tokens and truncates long payloads', () => {
  const previousLevel = getCodexLogLevel();
  const captured = [];
  const originalLog = console.log;
  console.log = (message) => captured.push(message);

  try {
    setCodexLogLevel('debug');
    codexDebug(`Bearer abc.def ${'x'.repeat(4000)}`);
  } finally {
    setCodexLogLevel(previousLevel);
    console.log = originalLog;
  }

  assert.equal(captured.length, 1);
  assert.match(captured[0], /Bearer \[REDACTED\]/);
  assert.match(captured[0], /\[truncated \d+ chars\]/);
});


test('codexLogger tracks emitted and suppressed stats by log level', () => {
  const previousLevel = getCodexLogLevel();
  const captured = [];
  const originalLog = console.log;
  console.log = (message) => captured.push(message);

  try {
    const start = getCodexLogStatsSnapshot();
    setCodexLogLevel('info');
    codexInfo('info-visible');
    codexDebug('debug-hidden');
    const end = getCodexLogStatsSnapshot();

    const infoEmittedDelta = end.levels.info.emitted - start.levels.info.emitted;
    const debugSuppressedDelta = end.levels.debug.suppressed - start.levels.debug.suppressed;
    assert.equal(infoEmittedDelta, 1);
    assert.equal(debugSuppressedDelta, 1);
    assert.equal(captured.length, 1);
  } finally {
    setCodexLogLevel(previousLevel);
    console.log = originalLog;
  }
});
