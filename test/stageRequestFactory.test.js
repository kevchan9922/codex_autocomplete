require('./helpers/registerVscode.js');

const test = require('node:test');
const assert = require('node:assert/strict');
const vscode = require('vscode');

const { RecencyContextStore } = require('../out/completion/contextEnrichment.js');
const {
  buildResolvedStageRequests,
  buildStageRequests,
} = require('../out/completion/stageRequestFactory.js');

test.skip('buildStageRequests builds fast request and full request cache keys', async () => {
  const recencyStore = new RecencyContextStore();
  const originalExecute = vscode.commands.executeCommand;
  vscode.commands.executeCommand = async () => [];

  try {
    const context = {
      prefix: 'line1\nline2\nline3',
      suffix: 'after1\nafter2\nafter3',
      selection: 'selected text',
      languageId: 'python',
      filePath: '/tmp/test.py',
    };

    const { fastRequest, fullRequestFactory } = buildStageRequests({
      context,
      dynamicCacheKey: 'k1',
      config: {
        fastStagePrefixLines: 1,
        fastStageSuffixLines: 1,
        maxOutputTokens: 64,
        serviceTier: 'priority',
        promptCacheRetention: '24h',
      },
      document: {
        uri: { fsPath: '/tmp/test.py', toString: () => '/tmp/test.py' },
        languageId: 'python',
        getText: () => '',
      },
      position: { line: 0, character: 0 },
      snapshotText: 'import os\nx = 1\n',
      recencyStore,
      explicitHotkeyTrigger: true,
    });

    assert.equal(fastRequest.prefix, 'line3');
    assert.equal(fastRequest.suffix, 'after1');
    assert.equal(fastRequest.selection, 'selected text');
    assert.equal(fastRequest.promptCacheKey, 'k1:fast');
    assert.equal(fastRequest.interactionMode, 'hotkey');
    assert.match(fastRequest.instructions ?? '', /Inline rules:/);
    assert.match(
      fastRequest.instructions ?? '',
      /If a token is already started, return only its missing suffix/,
    );
    assert.match(
      fastRequest.instructions ?? '',
      /Use context in this order: `cursor_context`, `priority_context`, `scope_context`, `ordered_context`\./,
    );
    assert.match(
      fastRequest.instructions ?? '',
      /Never repeat `line_prefix`\./,
    );
    assert.match(
      fastRequest.instructions ?? '',
      /Never duplicate `line_suffix`\./,
    );
    assert.match(
      fastRequest.instructions ?? '',
      /missing suffix/,
    );
    assert.match(
      fastRequest.instructions ?? '',
      /Read `ordered_context` top-to-bottom: current line first, then nearest prefix\/suffix lines expanding outward by distance\./,
    );
    assert.ok((fastRequest.instructions ?? '').length < 2200);

    const fullRequest = await fullRequestFactory();
    assert.equal(fullRequest.promptCacheKey, 'k1:full');
    assert.equal(fullRequest.interactionMode, 'hotkey');
    assert.equal(fullRequest.selection, 'selected text');
    assert.ok(fullRequest.context?.includes('IMPORTS:'), 'expected import context in full request');
    assert.equal(fullRequest.instructions, fastRequest.instructions);
  } finally {
    vscode.commands.executeCommand = originalExecute;
  }
});

test.skip('buildStageRequests adds context-preservation hints for nearby symbols', async () => {
  const recencyStore = new RecencyContextStore();
  const originalExecute = vscode.commands.executeCommand;
  vscode.commands.executeCommand = async () => [];

  try {
    const { fastRequest } = buildStageRequests({
      context: {
        prefix: [
          'def run_case() -> None:',
          '    filters = {"active": True}',
          '    tax_rate = 0.07',
          '    query = build_query("users", filters, ',
          '    message = greet(',
        ].join('\n'),
        suffix: [
          '    print(user.name)',
          '',
        ].join('\n'),
        languageId: 'python',
        filePath: '/tmp/test.py',
      },
      dynamicCacheKey: 'k2',
      config: {
        fastStagePrefixLines: 6,
        fastStageSuffixLines: 2,
      },
      document: {
        uri: { fsPath: '/tmp/test.py', toString: () => '/tmp/test.py' },
        languageId: 'python',
        getText: () => '',
      },
      position: { line: 0, character: 0 },
      snapshotText: 'pass\n',
      recencyStore,
      explicitHotkeyTrigger: false,
    });

    assert.match(fastRequest.instructions ?? '', /Context hints:/);
    assert.equal(fastRequest.interactionMode, 'automatic');
    assert.match(fastRequest.instructions ?? '', /PATHS: .*user\.name/);
    assert.match(fastRequest.instructions ?? '', /NUMS: 0\.07/);
  } finally {
    vscode.commands.executeCommand = originalExecute;
  }
});

test.skip('buildStageRequests adds partial-token hints for unique local continuations', async () => {
  const recencyStore = new RecencyContextStore();
  const originalExecute = vscode.commands.executeCommand;
  vscode.commands.executeCommand = async () => [];

  try {
    const { fastRequest } = buildStageRequests({
      context: {
        prefix: [
          'func maskedWordDemo() string {',
          '\tname := "Mina"',
          '\treturn nam',
        ].join('\n'),
        suffix: '\n}',
        languageId: 'go',
        filePath: '/tmp/test.go',
      },
      dynamicCacheKey: 'k2c',
      config: {
        fastStagePrefixLines: 4,
        fastStageSuffixLines: 2,
      },
      document: {
        uri: { fsPath: '/tmp/test.go', toString: () => '/tmp/test.go' },
        languageId: 'go',
        getText: () => '',
      },
      position: { line: 0, character: 0 },
      snapshotText: 'package main\n',
      recencyStore,
      explicitHotkeyTrigger: false,
    });

    assert.match(fastRequest.instructions ?? '', /PARTIAL: nam/);
    assert.match(fastRequest.instructions ?? '', /PARTIAL_NEARBY: name/);
  } finally {
    vscode.commands.executeCommand = originalExecute;
  }
});

test('buildResolvedStageRequests preserves prebuilt benchmark instructions when requested', async () => {
  const prebuiltInstructions = [
    'Return only code',
    '',
    'Retry requirements:',
    '- Retry reason: semantic_mismatch',
    '- Preserve required numeric literals exactly as implied by cursor scenario.',
  ].join('\n');

  const { fastRequest, fullRequestFactory } = buildResolvedStageRequests({
    context: {
      prefix: 'message = greet(',
      suffix: '',
      linePrefix: 'message = greet(',
      lineSuffix: '',
      languageId: 'python',
      filePath: '/tmp/test.py',
    },
    dynamicCacheKey: 'prebuilt',
    config: {
      fastStagePrefixLines: 4,
      fastStageSuffixLines: 2,
      instructions: prebuiltInstructions,
      instructionsPrebuilt: true,
    },
    interactionMode: 'hotkey',
    fullContextFactory: async () => 'EXTRA_CONTEXT',
  });

  assert.equal(fastRequest.instructions, prebuiltInstructions);
  assert.doesNotMatch(fastRequest.instructions ?? '', /Inline rules:/);
  const fullRequest = await fullRequestFactory();
  assert.equal(fullRequest.instructions, prebuiltInstructions);
  assert.equal(fullRequest.context, 'EXTRA_CONTEXT');
});

test('buildStageRequests omits named-argument and numeric hints outside call context', async () => {
  const recencyStore = new RecencyContextStore();
  const originalExecute = vscode.commands.executeCommand;
  vscode.commands.executeCommand = async () => [];

  try {
    const { fastRequest } = buildStageRequests({
      context: {
        prefix: [
          'def run_case() -> None:',
          '    query = build_query(table="users", filters=filters, limit=2, order_by="id")',
          '    result = query',
        ].join('\n'),
        suffix: '    return result\n',
        languageId: 'python',
        filePath: '/tmp/test.py',
      },
      dynamicCacheKey: 'k2b',
      config: {
        fastStagePrefixLines: 6,
        fastStageSuffixLines: 2,
      },
      document: {
        uri: { fsPath: '/tmp/test.py', toString: () => '/tmp/test.py' },
        languageId: 'python',
        getText: () => '',
      },
      position: { line: 0, character: 0 },
      snapshotText: 'pass\n',
      recencyStore,
      explicitHotkeyTrigger: false,
    });

    assert.doesNotMatch(
      fastRequest.instructions ?? '',
      /ARGS:/,
    );
    assert.doesNotMatch(
      fastRequest.instructions ?? '',
      /NUMS:/,
    );
  } finally {
    vscode.commands.executeCommand = originalExecute;
  }
});

test('buildStageRequests limits automatic symbol lookup latency in full-stage context', async () => {
  const recencyStore = new RecencyContextStore();
  const originalExecute = vscode.commands.executeCommand;
  let symbolLookupCalls = 0;
  vscode.commands.executeCommand = async (command) => {
    if (command === 'vscode.executeDocumentSymbolProvider') {
      symbolLookupCalls += 1;
      return new Promise(() => {});
    }
    return [];
  };

  try {
    const { fullRequestFactory } = buildStageRequests({
      context: {
        prefix: 'const value = compute(',
        suffix: ');',
        languageId: 'typescript',
        filePath: '/tmp/slow-symbol.ts',
      },
      dynamicCacheKey: 'k3',
      config: {
        fastStagePrefixLines: 4,
        fastStageSuffixLines: 2,
      },
      document: {
        uri: { fsPath: '/tmp/slow-symbol.ts', toString: () => '/tmp/slow-symbol.ts' },
        languageId: 'typescript',
        getText: () => '',
      },
      position: { line: 0, character: 0 },
      snapshotText: "import foo from 'bar';\nconst value = compute(\n",
      recencyStore,
      explicitHotkeyTrigger: false,
    });

    const startedAt = Date.now();
    const fullRequest = await fullRequestFactory();
    const elapsedMs = Date.now() - startedAt;

    assert.equal(symbolLookupCalls, 1);
    assert.ok(elapsedMs < 120);
    assert.ok(fullRequest.context?.includes('IMPORTS:'), 'expected import context');
  } finally {
    vscode.commands.executeCommand = originalExecute;
  }
});
