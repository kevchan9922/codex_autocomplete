require('./helpers/registerVscode.js');

const test = require('node:test');
const assert = require('node:assert/strict');
const vscode = require('vscode');

const { InlineTriggerGate } = require('../out/completion/triggerGate.js');

test('InlineTriggerGate allows automatic mode triggers', () => {
  const gate = new InlineTriggerGate('automatic');
  const result = gate.evaluateRequest(
    { triggerKind: vscode.InlineCompletionTriggerKind.Automatic },
    { isCancellationRequested: false },
  );

  assert.equal(result.allowed, true);
  assert.equal(result.explicitHotkeyTrigger, false);
  assert.equal(result.triggerKindLabel, 'automatic');
});

test('InlineTriggerGate blocks hotkey mode requests without manual window', () => {
  const gate = new InlineTriggerGate('hotkey');
  const result = gate.evaluateRequest(
    { triggerKind: vscode.InlineCompletionTriggerKind.Invoke },
    { isCancellationRequested: false },
  );

  assert.equal(result.allowed, false);
  assert.equal(result.explicitHotkeyTrigger, false);
});

test('InlineTriggerGate accepts automatic fallback in manual trigger window and consumes it once used', () => {
  const gate = new InlineTriggerGate('hotkey');

  gate.markManualTriggerWindow(1000);
  const first = gate.evaluateRequest(
    { triggerKind: vscode.InlineCompletionTriggerKind.Automatic },
    { isCancellationRequested: false },
  );
  const second = gate.evaluateRequest(
    { triggerKind: vscode.InlineCompletionTriggerKind.Invoke },
    { isCancellationRequested: false },
  );
  const third = gate.evaluateRequest(
    { triggerKind: vscode.InlineCompletionTriggerKind.Invoke },
    { isCancellationRequested: false },
  );

  assert.equal(first.allowed, true);
  assert.equal(first.explicitHotkeyTrigger, true);
  assert.equal(second.allowed, false);
  assert.equal(second.explicitHotkeyTrigger, false);
  assert.equal(third.allowed, false);
});

test('InlineTriggerGate skips cancelled requests', () => {
  const gate = new InlineTriggerGate('automatic');
  const result = gate.evaluateRequest(
    { triggerKind: vscode.InlineCompletionTriggerKind.Automatic },
    { isCancellationRequested: true },
  );

  assert.equal(result.allowed, false);
});
