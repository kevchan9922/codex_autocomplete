require('./helpers/registerVscode.js');

const test = require('node:test');
const assert = require('node:assert/strict');
const vscode = require('vscode');

const { waitForDebounce } = require('../out/completion/debounce.js');
const { CancellationManager } = require('../out/completion/cancellation.js');
const { InlineCompletionProvider } = require('../out/completion/inlineProvider.js');

const {
  getCodexLogLevel,
  setCodexLogLevel,
  setCodexLogSink,
} = require('../out/logging/codexLogger.js');

function createDocument(text, filePath = '/workspace/file.ts') {
  return {
    uri: { fsPath: filePath },
    languageId: 'typescript',
    getText: () => text,
  };
}

test('waitForDebounce resolves after delay and cancels on abort', async () => {
  await waitForDebounce(5);

  const controller = new AbortController();
  controller.abort();

  await assert.rejects(() => waitForDebounce(50, controller.signal), /Request cancelled/);
});

test('CancellationManager marks only newest request as latest', () => {
  const manager = new CancellationManager();
  const first = manager.begin('editor-1');
  const second = manager.begin('editor-1');

  assert.equal(first.signal.aborted, true);
  assert.equal(first.isLatest(), false);
  assert.equal(second.isLatest(), true);

  second.release();
  assert.equal(second.isLatest(), false);
});

test('CancellationManager supersedes in-flight request even when context hash matches', () => {
  const manager = new CancellationManager();
  const first = manager.begin('editor-1');
  const second = manager.begin('editor-1', {
  });

  assert.equal(first.signal.aborted, true);
  assert.notEqual(second.signal, first.signal);
  assert.equal(first.isLatest(), false);
  assert.equal(second.isLatest(), true);

  first.release();
  assert.equal(second.isLatest(), true);
  second.release();
  assert.equal(second.isLatest(), false);
});

test('InlineCompletionProvider keeps newest response and drops stale request', async () => {
  let firstCallStartedResolve;
  const firstCallStarted = new Promise((resolve) => {
    firstCallStartedResolve = resolve;
  });

  const aiProvider = {
    async *streamCompletion(_request, signal) {
      if (!firstCallStartedResolve) {
        throw new Error('Missing resolver');
      }

      if (!signal.aborted) {
        firstCallStartedResolve();
      }

      await new Promise((resolve) => setTimeout(resolve, 20));

      if (signal.aborted) {
        throw new Error('Request cancelled');
      }

      yield { text: 'new', done: false };
      yield { text: '', done: true };
    },
  };

  const provider = new InlineCompletionProvider(aiProvider, new CancellationManager(), {
    triggerMode: 'automatic',
    debounceMs: 0,
    context: {
      maxBeforeLines: 200,
      maxAfterLines: 20,
      maxContextChars: 12000,
      maxFileLines: 5000,
    },
  });

  const document = createDocument('const a = 1;\n');
  const token = { isCancellationRequested: false };

  const firstPromise = provider.provideInlineCompletionItems(
    document,
    { line: 1, character: 0 },
    { triggerKind: 0 },
    token,
  );

  await firstCallStarted;

  const secondPromise = provider.provideInlineCompletionItems(
    document,
    { line: 1, character: 0 },
    { triggerKind: 0 },
    token,
  );

  const [first, second] = await Promise.all([firstPromise, secondPromise]);

  assert.deepEqual(first, []);
  assert.deepEqual(second, [{ insertText: 'new' }]);
});

test('InlineCompletionProvider uses the extended latency budget in automatic mode', async () => {
  const aiProvider = {
    async *streamCompletion(_request, signal) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (signal.aborted) {
        throw new Error('Request cancelled');
      }
      yield { text: 'late', done: false };
      yield { text: '', done: true };
    },
  };

  const provider = new InlineCompletionProvider(aiProvider, new CancellationManager(), {
    triggerMode: 'automatic',
    debounceMs: 0,
    maxLatencyMs: 5,
    context: {
      maxBeforeLines: 200,
      maxAfterLines: 20,
      maxContextChars: 12000,
      maxFileLines: 5000,
    },
  });

  const document = createDocument('import foo from \"bar\";\\n');
  const token = { isCancellationRequested: false };

  const result = await provider.provideInlineCompletionItems(
    document,
    { line: 0, character: 0 },
    { triggerKind: 0 },
    token,
  );

  assert.deepEqual(result, [{ insertText: 'late' }]);
});

test('InlineCompletionProvider preserves grounded blank-line assignments that are valid local continuations', async () => {
  let streamCallCount = 0;
  const aiProvider = {
    async *streamCompletion() {
      streamCallCount += 1;
      yield { text: 'message = "hi"', done: false };
      yield { text: '', done: true };
    },
  };

  const provider = new InlineCompletionProvider(aiProvider, new CancellationManager(), {
    triggerMode: 'automatic',
    debounceMs: 0,
    context: {
      maxBeforeLines: 200,
      maxAfterLines: 20,
      maxContextChars: 12000,
      maxFileLines: 5000,
    },
  });

  const document = {
    uri: { fsPath: '/workspace/file.py' },
    languageId: 'python',
    getText: () => ['def run() -> str:', '    value = "ok"', '    ', '    return value'].join('\n'),
  };

  const result = await provider.provideInlineCompletionItems(
    document,
    { line: 2, character: 4 },
    { triggerKind: 0 },
    { isCancellationRequested: false },
  );

  assert.deepEqual(result, [{ insertText: 'message = "hi"' }]);
  assert.equal(streamCallCount, 1);
});

test('InlineCompletionProvider drops duplicated blank-line suffix suggestions when no grounded fallback exists', async () => {
  let streamCallCount = 0;
  const aiProvider = {
    async *streamCompletion() {
      streamCallCount += 1;
      yield { text: 'return Query(table=table, filters=filters, limit=limit, order_by=order_by)', done: false };
      yield { text: '', done: true };
    },
  };

  const provider = new InlineCompletionProvider(aiProvider, new CancellationManager(), {
    triggerMode: 'automatic',
    debounceMs: 0,
    context: {
      maxBeforeLines: 200,
      maxAfterLines: 20,
      maxContextChars: 12000,
      maxFileLines: 5000,
    },
  });

  const document = {
    uri: { fsPath: '/workspace/file.py' },
    languageId: 'python',
    getText: () => [
      'from dataclasses import dataclass',
      '',
      '@dataclass',
      'class Query:',
      '    table: str',
      '    filters: dict[str, object]',
      '    limit: int',
      '    order_by: str',
      '',
      'def build_query(table: str, filters: dict[str, object], limit: int, order_by: str) -> Query:',
      '    ',
      '    #      ',
      '    return Query(table=table, filters=filters, limit=limit, order_by=order_by)',
    ].join('\n'),
  };

  const result = await provider.provideInlineCompletionItems(
    document,
    { line: 10, character: 4 },
    { triggerKind: 0 },
    { isCancellationRequested: false },
  );

  assert.deepEqual(result, []);
  assert.equal(streamCallCount, 1);
});


test('InlineCompletionProvider emits empty-result diagnostic log contract when suggestion is dropped', async () => {
  const previousLevel = getCodexLogLevel();
  const capturedLogs = [];
  setCodexLogLevel('info');
  setCodexLogSink((line) => capturedLogs.push(line));

  let streamCallCount = 0;
  const aiProvider = {
    async *streamCompletion() {
      streamCallCount += 1;
      yield { text: 'return Query(table=table, filters=filters, limit=limit, order_by=order_by)', done: false };
      yield { text: '', done: true };
    },
  };

  try {
    const provider = new InlineCompletionProvider(aiProvider, new CancellationManager(), {
      triggerMode: 'automatic',
      debounceMs: 0,
      context: {
        maxBeforeLines: 200,
        maxAfterLines: 20,
        maxContextChars: 12000,
        maxFileLines: 5000,
      },
    });

    const document = {
      uri: { fsPath: '/workspace/file.py' },
      languageId: 'python',
      getText: () => [
        'from dataclasses import dataclass',
        '',
        '@dataclass',
        'class Query:',
        '    table: str',
        '    filters: dict[str, object]',
        '    limit: int',
        '    order_by: str',
        '',
        'def build_query(table: str, filters: dict[str, object], limit: int, order_by: str) -> Query:',
        '    ',
        '    #      ',
        '    return Query(table=table, filters=filters, limit=limit, order_by=order_by)',
      ].join('\n'),
    };

    const result = await provider.provideInlineCompletionItems(
      document,
      { line: 10, character: 4 },
      { triggerKind: 0 },
      { isCancellationRequested: false },
    );

    assert.deepEqual(result, []);
    assert.equal(streamCallCount, 1);

    const diagnosticLine = capturedLogs.find((line) =>
      line.includes('[codex] inline suggestion resolved empty raw='),
    );
    assert.ok(diagnosticLine, 'expected empty-result diagnostic log line');
    assert.match(diagnosticLine, /raw="return Query\(/);
    assert.match(diagnosticLine, /repaired=""/);
    assert.match(diagnosticLine, /reasons=\["dropDuplicateLaterSuffixLine"\]/);
    assert.match(diagnosticLine, /timedOutBeforeFirstChunk=false/);
    assert.match(diagnosticLine, /timedOut=false/);
  } finally {
    setCodexLogSink(undefined);
    setCodexLogLevel(previousLevel);
  }
});

test('InlineCompletionProvider retries after dropping a duplicate later suffix line', async () => {
  const previousLevel = getCodexLogLevel();
  const capturedLogs = [];
  setCodexLogLevel('info');
  setCodexLogSink((line) => capturedLogs.push(line));

  try {
    const provider = new InlineCompletionProvider({
      async *streamCompletion() {
        yield { text: '', done: true };
      },
    }, new CancellationManager(), {
      triggerMode: 'hotkey',
      debounceMs: 0,
      hotkeySemanticRetryEnabled: true,
      hotkeySemanticRetryMaxLatencyMs: 500,
      hotkeySemanticRetryFirstChunkMaxLatencyMs: 500,
      context: {
        maxBeforeLines: 200,
        maxAfterLines: 20,
        maxContextChars: 12000,
        maxFileLines: 5000,
      },
    });
    const duplicateRetryCalls = [];
    provider.completionPipeline.getSuggestion = async () => ({
      suggestion: 'return Query(table=table, filters=filters, limit=limit, order_by=order_by)',
      completedContextHashHit: false,
      timedOutBeforeFirstChunk: false,
      timedOut: false,
    });
    provider.completionPipeline.runHotkeyDuplicateRetry = async (input) => {
      duplicateRetryCalls.push(input);
      return {
        suggestion: 'query = Query(table=table, filters=filters, limit=limit, order_by=order_by)',
        timedOutBeforeFirstChunk: false,
        timedOut: false,
      };
    };

    const document = {
      uri: { fsPath: '/workspace/file.py' },
      languageId: 'python',
      getText: () => [
        'from dataclasses import dataclass',
        '',
        '@dataclass',
        'class Query:',
        '    table: str',
        '    filters: dict[str, object]',
        '    limit: int',
        '    order_by: str',
        '',
        'def build_query(table: str, filters: dict[str, object], limit: int, order_by: str) -> Query:',
        '    ',
        '    # placeholder',
        '    return Query(table=table, filters=filters, limit=limit, order_by=order_by)',
      ].join('\n'),
    };
    provider.markManualTriggerWindow();

    const result = await provider.provideInlineCompletionItems(
      document,
      { line: 10, character: 4 },
      { triggerKind: 0 },
      { isCancellationRequested: false },
    );

    assert.equal(duplicateRetryCalls.length, 1);
    assert.equal(
      duplicateRetryCalls[0].forbiddenDuplicate,
      'return Query(table=table, filters=filters, limit=limit, order_by=order_by)',
    );
    assert.ok(Array.isArray(result));
    assert.equal(result.length, 1);
    assert.match(capturedLogs.join('\n'), /duplicate-later-suffix retry triggered/);
    assert.match(capturedLogs.join('\n'), /duplicate-later-suffix retry used/);
  } finally {
    setCodexLogSink(undefined);
    setCodexLogLevel(previousLevel);
  }
});

test('InlineCompletionProvider uses the extended first-chunk budget in automatic mode', async () => {
  const vscode = require('vscode');
  const messages = [];
  const originalShowInformationMessage = vscode.window.showInformationMessage;
  vscode.window.showInformationMessage = async (message) => {
    messages.push(message);
    return undefined;
  };

  const aiProvider = {
    async *streamCompletion(_request, signal) {
      await new Promise((resolve) => setTimeout(resolve, 80));
      if (signal.aborted) {
        throw new Error('Request cancelled');
      }
      yield { text: 'late-first-token', done: false };
      yield { text: '', done: true };
    },
  };

  try {
    const provider = new InlineCompletionProvider(aiProvider, new CancellationManager(), {
      triggerMode: 'automatic',
      debounceMs: 0,
      maxLatencyMs: 4000,
      firstChunkMaxLatencyMs: 25,
      context: {
        maxBeforeLines: 200,
        maxAfterLines: 20,
        maxContextChars: 12000,
        maxFileLines: 5000,
      },
    });

    const startedAt = Date.now();
    const result = await provider.provideInlineCompletionItems(
      createDocument('const value = 1;\n'),
      { line: 1, character: 0 },
      { triggerKind: 0 },
      { isCancellationRequested: false },
    );

    assert.deepEqual(result, [{ insertText: 'late-first-token' }]);
    assert.ok(Date.now() - startedAt < 600);
    assert.ok(
      !messages.includes('No autocomplete - timed out waiting for first token (25ms)'),
    );
    assert.ok(!messages.includes('No autocomplete - empty response from model'));
  } finally {
    vscode.window.showInformationMessage = originalShowInformationMessage;
  }
});

test('InlineCompletionProvider keeps the model result when automatic mode no longer times out first chunk', async () => {
  const aiProvider = {
    async *streamCompletion(_request, signal) {
      await new Promise((resolve) => setTimeout(resolve, 80));
      if (signal.aborted) {
        throw new Error('Request cancelled');
      }
      yield { text: 'late-first-token', done: false };
      yield { text: '', done: true };
    },
  };

  const provider = new InlineCompletionProvider(aiProvider, new CancellationManager(), {
    triggerMode: 'automatic',
    debounceMs: 0,
    maxLatencyMs: 1000,
    firstChunkMaxLatencyMs: 25,
    context: {
      maxBeforeLines: 200,
      maxAfterLines: 20,
      maxContextChars: 12000,
      maxFileLines: 5000,
    },
  });

  const text = [
    'def run(values: list[int]) -> str:',
    '    first = summarize(values)',
    '    return',
  ].join('\n');
  const document = {
    uri: { fsPath: '/workspace/file.py' },
    languageId: 'python',
    getText: () => text,
  };

  const result = await provider.provideInlineCompletionItems(
    document,
    { line: 2, character: '    return'.length },
    { triggerKind: 0 },
    { isCancellationRequested: false },
  );

  assert.deepEqual(result, [{ insertText: 'late-first-token' }]);
});

test('InlineCompletionProvider suppresses first empty hotkey notification while auto-retrying non-blank hotkey cursors', async () => {
  const vscode = require('vscode');
  const messages = [];
  const originalShowInformationMessage = vscode.window.showInformationMessage;
  vscode.window.showInformationMessage = async (message) => {
    messages.push(message);
    return undefined;
  };

  try {
    const aiProvider = {
      async *streamCompletion() {
        yield { text: '', done: true };
      },
    };

    const provider = new InlineCompletionProvider(aiProvider, new CancellationManager(), {
      triggerMode: 'hotkey',
      debounceMs: 0,
      maxLatencyMs: 1000,
      hotkeySemanticRetryEnabled: false,
      context: {
        maxBeforeLines: 200,
        maxAfterLines: 20,
        maxContextChars: 12000,
        maxFileLines: 5000,
      },
    });

    provider.markManualTriggerWindow();
    const result = await provider.provideInlineCompletionItems(
      createDocument('const value = greet('),
      { line: 0, character: 'const value = greet('.length },
      { triggerKind: 1 },
      { isCancellationRequested: false },
    );

    assert.deepEqual(result, []);
    assert.ok(!messages.includes('No autocomplete - empty response from model'));
  } finally {
    vscode.window.showInformationMessage = originalShowInformationMessage;
  }
});

test('InlineCompletionProvider re-arms hotkey fallback after cancellation before returning a suggestion', async () => {
  const document = createDocument('const value = 1;\n');
  const token = { isCancellationRequested: false };
  let callCount = 0;
  const seenCommands = [];
  const originalExecuteCommand = vscode.commands.executeCommand;
  vscode.commands.executeCommand = async (commandId, ...args) => {
    seenCommands.push(commandId);
    if (commandId === 'editor.action.inlineSuggest.trigger') {
      return undefined;
    }
    return originalExecuteCommand.call(vscode.commands, commandId, ...args);
  };

  const aiProvider = {
    async *streamCompletion() {
      callCount += 1;
      if (callCount === 1) {
        yield { text: 'hotkey-result', done: false };
        token.isCancellationRequested = true;
        yield { text: '', done: true };
        return;
      }
      yield { text: 'hotkey-retriggered', done: false };
      yield { text: '', done: true };
    },
  };

  try {
    const provider = new InlineCompletionProvider(aiProvider, new CancellationManager(), {
      triggerMode: 'hotkey',
      debounceMs: 0,
      hotkeySemanticRetryEnabled: false,
      maxLatencyMs: 1000,
      context: {
        maxBeforeLines: 200,
        maxAfterLines: 20,
        maxContextChars: 12000,
        maxFileLines: 5000,
      },
    });

    provider.markManualTriggerForDocument(document);
    provider.markManualTriggerWindow();
    const first = await provider.provideInlineCompletionItems(
      document,
      { line: 0, character: 0 },
      { triggerKind: 0 },
      token,
    );

    token.isCancellationRequested = false;
    const second = await provider.provideInlineCompletionItems(
      document,
      { line: 0, character: 0 },
      { triggerKind: 0 },
      token,
    );

    assert.deepEqual(first, []);
    assert.deepEqual(second, [{ insertText: 'hotkey-retriggered' }]);
    assert.ok(seenCommands.includes('editor.action.inlineSuggest.trigger'));
  } finally {
    vscode.commands.executeCommand = originalExecuteCommand;
  }
});

test('InlineCompletionProvider notifies when repeated non-blank hotkey retries still return empty', async () => {
  const vscode = require('vscode');
  const messages = [];
  const originalShowInformationMessage = vscode.window.showInformationMessage;
  vscode.window.showInformationMessage = async (message) => {
    messages.push(message);
    return undefined;
  };

  try {
    const aiProvider = {
      async *streamCompletion() {
        yield { text: '', done: true };
      },
    };

    const provider = new InlineCompletionProvider(aiProvider, new CancellationManager(), {
      triggerMode: 'hotkey',
      debounceMs: 0,
      maxLatencyMs: 1000,
      context: {
        maxBeforeLines: 200,
        maxAfterLines: 20,
        maxContextChars: 12000,
        maxFileLines: 5000,
      },
    });

    provider.markManualTriggerWindow();
    const first = await provider.provideInlineCompletionItems(
      createDocument('const value = greet('),
      { line: 0, character: 'const value = greet('.length },
      { triggerKind: 1 },
      { isCancellationRequested: false },
    );
    provider.markManualTriggerWindow();
    const second = await provider.provideInlineCompletionItems(
      createDocument('const value = greet('),
      { line: 0, character: 'const value = greet('.length },
      { triggerKind: 1 },
      { isCancellationRequested: false },
    );

    assert.deepEqual(first, []);
    assert.deepEqual(second, []);
    assert.ok(messages.includes('No autocomplete - empty response from model'));
  } finally {
    vscode.window.showInformationMessage = originalShowInformationMessage;
  }
});

test('InlineCompletionProvider passes extra context to provider', async () => {
  const { RecencyContextStore } = require('../out/completion/contextEnrichment.js');
  const recencyStore = new RecencyContextStore();
  recencyStore.recordSnapshot(
    { text: 'const x = 1;', languageId: 'typescript', filePath: '/workspace/other.ts' },
    { line: 0, character: 0 },
  );

  const aiProvider = {
    async *streamCompletion(request) {
      assert.ok(request.context, 'expected context string to be provided');
      assert.ok(request.context.includes('IMPORTS:'), 'missing imports in context');
      assert.ok(request.context.includes('RECENT_CONTEXT:'), 'expected recency context by default');
      assert.ok(request.context.includes('FILE: other.ts'), 'expected most recent file in recency context');
      yield { text: 'ok', done: false };
      yield { text: '', done: true };
    },
  };

  const provider = new InlineCompletionProvider(
    aiProvider,
    new CancellationManager(),
    {
      triggerMode: 'automatic',
      debounceMs: 0,
      maxLatencyMs: 1000,
      context: {
        maxBeforeLines: 200,
        maxAfterLines: 20,
        maxContextChars: 12000,
        maxFileLines: 5000,
      },
    },
    undefined,
    recencyStore,
  );

  const document = createDocument('import foo from \"bar\";\\n');
  const token = { isCancellationRequested: false };

  const result = await provider.provideInlineCompletionItems(
    document,
    { line: 0, character: 0 },
    { triggerKind: 0 },
    token,
  );

  assert.deepEqual(result, [{ insertText: 'ok' }]);
});

test('InlineCompletionProvider attaches acceptance command payload when configured', async () => {
  const aiProvider = {
    async *streamCompletion() {
      yield { text: 'accept-me', done: false };
      yield { text: '', done: true };
    },
  };

  const provider = new InlineCompletionProvider(aiProvider, new CancellationManager(), {
    triggerMode: 'automatic',
    debounceMs: 0,
    acceptanceLogCommandId: 'codexAutocomplete._inlineSuggestionAccepted',
    maxLatencyMs: 1000,
    context: {
      maxBeforeLines: 200,
      maxAfterLines: 20,
      maxContextChars: 12000,
      maxFileLines: 5000,
    },
  });

  const result = await provider.provideInlineCompletionItems(
    createDocument('const value = 1;\n'),
    { line: 0, character: 0 },
    { triggerKind: 0 },
    { isCancellationRequested: false },
  );

  assert.equal(result.length, 1);
  assert.equal(result[0].insertText, 'accept-me');
  assert.equal(result[0].command?.command, 'codexAutocomplete._inlineSuggestionAccepted');
  assert.equal(result[0].command?.title, 'Codex Autocomplete: Inline Suggestion Accepted');
  assert.ok(Array.isArray(result[0].command?.arguments));
  assert.equal(result[0].command?.arguments?.length, 1);

  const payload = result[0].command?.arguments?.[0];
  assert.equal(payload.requestId, 1);
  assert.equal(payload.editorKey, '/workspace/file.ts');
  assert.equal(payload.line, 0);
  assert.equal(payload.character, 0);
  assert.equal(payload.suggestionLength, 9);
  assert.equal(payload.suggestionPreview, 'accept-me');
});

test('InlineCompletionProvider clears generating status when a suggestion is returned', async () => {
  const aiProvider = {
    async *streamCompletion() {
      yield { text: 'ready', done: false };
      yield { text: '', done: true };
    },
  };
  let disposeCount = 0;
  let triggerController;
  let progressPromise;
  const originalWithProgress = vscode.window.withProgress;
  vscode.window.withProgress = async (_options, task) => {
    progressPromise = Promise.resolve(task()).then(() => {
      disposeCount += 1;
    });
    return progressPromise;
  };

  try {
    const { InlineUiController } = require('../out/completion/inlineUiController.js');
    triggerController = new InlineUiController();
    triggerController.notifyHotkeyTriggered();

    const provider = new InlineCompletionProvider(aiProvider, new CancellationManager(), {
      triggerMode: 'automatic',
      debounceMs: 0,
      maxLatencyMs: 1000,
      context: {
        maxBeforeLines: 200,
        maxAfterLines: 20,
        maxContextChars: 12000,
        maxFileLines: 5000,
      },
    });

    const result = await provider.provideInlineCompletionItems(
      createDocument('const value = 1;\n'),
      { line: 0, character: 0 },
      { triggerKind: 0 },
      { isCancellationRequested: false },
    );

    assert.equal(result.length, 1);
    assert.equal(result[0].insertText, 'ready');
    await progressPromise;
    assert.equal(disposeCount, 1);
  } finally {
    triggerController?.dispose();
    vscode.window.withProgress = originalWithProgress;
  }
});

test('InlineCompletionProvider anchors ghost text range at cursor when vscode.Range is available', async () => {
  const providerModulePath = require.resolve('../out/completion/inlineProvider.js');
  const cachedInlineProviderModule = require.cache[providerModulePath];
  const originalRange = vscode.Range;
  vscode.Range = class {
    constructor(start, end) {
      this.start = start;
      this.end = end;
    }
  };

  try {
    const aiProvider = {
      async *streamCompletion() {
        yield { text: 'ummary', done: false };
        yield { text: '', done: true };
      },
    };

    delete require.cache[providerModulePath];
    const { InlineCompletionProvider: RangeAwareInlineCompletionProvider } = require(providerModulePath);
    const provider = new RangeAwareInlineCompletionProvider(aiProvider, new CancellationManager(), {
      triggerMode: 'automatic',
      debounceMs: 0,
      maxLatencyMs: 1000,
      context: {
        maxBeforeLines: 200,
        maxAfterLines: 20,
        maxContextChars: 12000,
        maxFileLines: 5000,
      },
    });

    const linePrefix = '    return report_s';
    const position = { line: 0, character: linePrefix.length };
    const result = await provider.provideInlineCompletionItems(
      createDocument(`${linePrefix}\n`),
      position,
      { triggerKind: 0 },
      { isCancellationRequested: false },
    );

    assert.equal(result.length, 1);
    assert.equal(result[0].insertText, 'ummary');
    assert.ok(result[0].range);
    assert.equal(result[0].range.start.line, position.line);
    assert.equal(result[0].range.start.character, position.character);
    assert.equal(result[0].range.end.line, position.line);
    assert.equal(result[0].range.end.character, position.character);
  } finally {
    if (typeof originalRange === 'undefined') {
      delete vscode.Range;
    } else {
      vscode.Range = originalRange;
    }
    delete require.cache[providerModulePath];
    if (cachedInlineProviderModule) {
      require.cache[providerModulePath] = cachedInlineProviderModule;
    }
  }
});

test('InlineCompletionProvider uses fast-stage result without full-stage fallback', async () => {
  const seen = [];
  const aiProvider = {
    async *streamCompletion(request) {
      seen.push(request);
      if (request.context !== undefined) {
        throw new Error('full stage should not run when fast stage succeeds');
      }
      yield { text: 'fast-result', done: false };
      yield { text: '', done: true };
    },
  };

  const provider = new InlineCompletionProvider(aiProvider, new CancellationManager(), {
    triggerMode: 'automatic',
    debounceMs: 0,
    maxLatencyMs: 1000,
    fastStageMaxLatencyMs: 1000,
    context: {
      maxBeforeLines: 200,
      maxAfterLines: 20,
      maxContextChars: 12000,
      maxFileLines: 5000,
    },
  });

  const document = createDocument('const answer = 42;\n');
  const token = { isCancellationRequested: false };
  const result = await provider.provideInlineCompletionItems(
    document,
    { line: 1, character: 0 },
    { triggerKind: 0 },
    token,
  );

  assert.deepEqual(result, [{ insertText: 'fast-result' }]);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].context, undefined);
  assert.ok(typeof seen[0].promptCacheKey === 'string');
  assert.ok(seen[0].promptCacheKey.endsWith(':fast'));
});

test('InlineCompletionProvider prewarms full-context build while fast-stage runs', async () => {
  const originalExecute = vscode.commands.executeCommand;
  let symbolLookupCalls = 0;
  vscode.commands.executeCommand = async (command) => {
    if (command === 'vscode.executeDocumentSymbolProvider') {
      symbolLookupCalls += 1;
    }
    return [];
  };

  const aiProvider = {
    async *streamCompletion(request) {
      if (request.context !== undefined) {
        throw new Error('full stage should not run when fast stage succeeds');
      }
      yield { text: 'fast-only', done: false };
      yield { text: '', done: true };
    },
  };

  try {
    const provider = new InlineCompletionProvider(aiProvider, new CancellationManager(), {
      triggerMode: 'automatic',
      debounceMs: 0,
      maxLatencyMs: 1000,
      fastStageMaxLatencyMs: 1000,
      context: {
        maxBeforeLines: 200,
        maxAfterLines: 20,
        maxContextChars: 12000,
        maxFileLines: 5000,
      },
    });

    const document = createDocument("import foo from 'bar';\nconst answer = 42;\n");
    const token = { isCancellationRequested: false };
    const result = await provider.provideInlineCompletionItems(
      document,
      { line: 1, character: 0 },
      { triggerKind: 0 },
      token,
    );

    assert.deepEqual(result, [{ insertText: 'fast-only' }]);
    assert.equal(symbolLookupCalls, 1);
  } finally {
    vscode.commands.executeCommand = originalExecute;
  }
});

test('InlineCompletionProvider falls back to full-stage when fast-stage is empty', async () => {
  const seen = [];
  const aiProvider = {
    async *streamCompletion(request) {
      seen.push(request);
      if (request.context === undefined) {
        yield { text: '', done: true };
        return;
      }
      yield { text: 'full-result', done: false };
      yield { text: '', done: true };
    },
  };

  const provider = new InlineCompletionProvider(aiProvider, new CancellationManager(), {
    triggerMode: 'automatic',
    debounceMs: 0,
    maxLatencyMs: 1000,
    fastStageMaxLatencyMs: 200,
    promptCacheKey: 'codex-autocomplete',
    context: {
      maxBeforeLines: 200,
      maxAfterLines: 20,
      maxContextChars: 12000,
      maxFileLines: 5000,
    },
  });

  const document = createDocument("import foo from 'bar';\nconst x = foo();\n");
  const token = { isCancellationRequested: false };
  const result = await provider.provideInlineCompletionItems(
    document,
    { line: 1, character: 5 },
    { triggerKind: 0 },
    token,
  );

  assert.deepEqual(result, [{ insertText: 'full-result' }]);
  assert.equal(seen.length, 2);
  assert.equal(seen[0].context, undefined);
  assert.ok(seen[1].context, 'expected full-stage context to be populated');
  assert.ok(seen[0].promptCacheKey.endsWith(':fast'));
  assert.ok(seen[1].promptCacheKey.endsWith(':full'));
});

test('InlineCompletionProvider falls back to full-stage when fast-stage errors', async () => {
  const seen = [];
  const aiProvider = {
    async *streamCompletion(request) {
      seen.push(request);
      if (request.context === undefined) {
        throw new Error('fast-stage failure');
      }
      yield { text: 'from-full-after-error', done: false };
      yield { text: '', done: true };
    },
  };

  const provider = new InlineCompletionProvider(aiProvider, new CancellationManager(), {
    triggerMode: 'automatic',
    debounceMs: 0,
    maxLatencyMs: 1000,
    fastStageMaxLatencyMs: 200,
    context: {
      maxBeforeLines: 200,
      maxAfterLines: 20,
      maxContextChars: 12000,
      maxFileLines: 5000,
    },
  });

  const document = createDocument("import foo from 'bar';\nconst x = foo();\n");
  const token = { isCancellationRequested: false };
  const result = await provider.provideInlineCompletionItems(
    document,
    { line: 1, character: 5 },
    { triggerKind: 0 },
    token,
  );

  assert.deepEqual(result, [{ insertText: 'from-full-after-error' }]);
  assert.equal(seen.length, 2);
  assert.equal(seen[0].context, undefined);
  assert.ok(seen[1].context);
});

test('InlineCompletionProvider exposes debug metrics with first chunk latency percentiles', async () => {
  const aiProvider = {
    async *streamCompletion() {
      yield { text: 'metric', done: false };
      yield { text: '', done: true };
    },
  };

  const provider = new InlineCompletionProvider(aiProvider, new CancellationManager(), {
    triggerMode: 'automatic',
    debounceMs: 0,
    maxLatencyMs: 1000,
    context: {
      maxBeforeLines: 200,
      maxAfterLines: 20,
      maxContextChars: 12000,
      maxFileLines: 5000,
    },
  });

  const result = await provider.provideInlineCompletionItems(
    createDocument('const m = 1;\n'),
    { line: 1, character: 0 },
    { triggerKind: 0 },
    { isCancellationRequested: false },
  );

  assert.deepEqual(result, [{ insertText: 'metric' }]);
  const metrics = provider.getDebugMetrics();
  assert.equal(metrics.totals.successfulRequests, 1);
  assert.ok(metrics.firstChunkP50Ms >= 0);
  assert.ok(metrics.firstChunkP95Ms >= 0);
  assert.equal(metrics.fastStageHitRate, 1);
  assert.equal(metrics.fastStageFallbackRate, 0);
  assert.ok(metrics.fastStageP50Ms >= 0);
  assert.equal(metrics.fullStageRuns, 0);
});


test('InlineCompletionProvider skips automatic triggers in hotkey mode', async () => {
  let callCount = 0;
  const aiProvider = {
    async *streamCompletion() {
      callCount += 1;
      yield { text: 'hotkey-only', done: false };
      yield { text: '', done: true };
    },
  };

  const provider = new InlineCompletionProvider(aiProvider, new CancellationManager(), {
    triggerMode: 'hotkey',
    debounceMs: 0,
    context: {
      maxBeforeLines: 200,
      maxAfterLines: 20,
      maxContextChars: 12000,
      maxFileLines: 5000,
    },
  });

  const result = await provider.provideInlineCompletionItems(
    createDocument('const value = 1;\n'),
    { line: 0, character: 0 },
    { triggerKind: 0 },
    { isCancellationRequested: false },
  );

  assert.deepEqual(result, []);
  assert.equal(callCount, 0);
});

test('InlineCompletionProvider skips invoke triggers in hotkey mode without manual window', async () => {
  let callCount = 0;
  const aiProvider = {
    async *streamCompletion() {
      callCount += 1;
      yield { text: 'hotkey-only', done: false };
      yield { text: '', done: true };
    },
  };

  const provider = new InlineCompletionProvider(aiProvider, new CancellationManager(), {
    triggerMode: 'hotkey',
    debounceMs: 0,
    context: {
      maxBeforeLines: 200,
      maxAfterLines: 20,
      maxContextChars: 12000,
      maxFileLines: 5000,
    },
  });

  const result = await provider.provideInlineCompletionItems(
    createDocument('const value = 1;\n'),
    { line: 0, character: 0 },
    { triggerKind: 1 },
    { isCancellationRequested: false },
  );

  assert.deepEqual(result, []);
  assert.equal(callCount, 0);
});

test('InlineCompletionProvider serves invoke triggers in hotkey mode', async () => {
  let callCount = 0;
  const aiProvider = {
    async *streamCompletion() {
      callCount += 1;
      yield { text: 'hotkey-only', done: false };
      yield { text: '', done: true };
    },
  };

  const provider = new InlineCompletionProvider(aiProvider, new CancellationManager(), {
    triggerMode: 'hotkey',
    debounceMs: 0,
    hotkeySemanticRetryEnabled: false,
    maxLatencyMs: 1000,
    context: {
      maxBeforeLines: 200,
      maxAfterLines: 20,
      maxContextChars: 12000,
      maxFileLines: 5000,
    },
  });

  provider.markManualTriggerWindow();
  const result = await provider.provideInlineCompletionItems(
    createDocument('const value = 1;\n'),
    { line: 0, character: 0 },
    { triggerKind: 1 },
    { isCancellationRequested: false },
  );

  assert.deepEqual(result, [{ insertText: 'hotkey-only' }]);
  assert.equal(callCount, 1);
});

test('InlineCompletionProvider accepts automatic fallback trigger in hotkey manual window', async () => {
  let callCount = 0;
  const aiProvider = {
    async *streamCompletion() {
      callCount += 1;
      yield { text: 'hotkey-auto-fallback', done: false };
      yield { text: '', done: true };
    },
  };

  const provider = new InlineCompletionProvider(aiProvider, new CancellationManager(), {
    triggerMode: 'hotkey',
    debounceMs: 0,
    hotkeySemanticRetryEnabled: false,
    maxLatencyMs: 1000,
    context: {
      maxBeforeLines: 200,
      maxAfterLines: 20,
      maxContextChars: 12000,
      maxFileLines: 5000,
    },
  });

  const document = createDocument('const value = 1;\n');
  provider.markManualTriggerWindow();
  const automatic = await provider.provideInlineCompletionItems(
    document,
    { line: 0, character: 0 },
    { triggerKind: 0 },
    { isCancellationRequested: false },
  );
  const invoke = await provider.provideInlineCompletionItems(
    document,
    { line: 0, character: 0 },
    { triggerKind: 1 },
    { isCancellationRequested: false },
  );

  assert.deepEqual(automatic, [{ insertText: 'hotkey-auto-fallback' }]);
  assert.deepEqual(invoke, []);
  assert.equal(callCount, 1);
});

test('InlineCompletionProvider clears manual invoke burst after automatic fallback trigger', async () => {
  let callCount = 0;
  const aiProvider = {
    async *streamCompletion() {
      callCount += 1;
      yield { text: 'hotkey-auto-once', done: false };
      yield { text: '', done: true };
    },
  };

  const provider = new InlineCompletionProvider(aiProvider, new CancellationManager(), {
    triggerMode: 'hotkey',
    debounceMs: 0,
    hotkeySemanticRetryEnabled: false,
    maxLatencyMs: 1000,
    context: {
      maxBeforeLines: 200,
      maxAfterLines: 20,
      maxContextChars: 12000,
      maxFileLines: 5000,
    },
  });

  const document = createDocument('const value = 1;\n');
  provider.markManualTrigger(document.uri.fsPath);
  provider.markManualTriggerWindow();

  const automatic = await provider.provideInlineCompletionItems(
    document,
    { line: 0, character: 0 },
    { triggerKind: 0 },
    { isCancellationRequested: false },
  );
  const invoke = await provider.provideInlineCompletionItems(
    document,
    { line: 0, character: 0 },
    { triggerKind: 1 },
    { isCancellationRequested: false },
  );

  assert.deepEqual(automatic, [{ insertText: 'hotkey-auto-once' }]);
  assert.deepEqual(invoke, []);
  assert.equal(callCount, 1);
});

test('InlineCompletionProvider retriggers once after empty hotkey result so the next invoke can return ghost text', async () => {
  let callCount = 0;
  const aiProvider = {
    async *streamCompletion() {
      callCount += 1;
      if (callCount <= 2) {
        yield { text: '', done: true };
        return;
      }
      yield { text: 'hotkey-second-pass', done: false };
      yield { text: '', done: true };
    },
  };

  const provider = new InlineCompletionProvider(aiProvider, new CancellationManager(), {
    triggerMode: 'hotkey',
    debounceMs: 0,
    hotkeySemanticRetryEnabled: false,
    maxLatencyMs: 1000,
    context: {
      maxBeforeLines: 200,
      maxAfterLines: 20,
      maxContextChars: 12000,
      maxFileLines: 5000,
    },
  });

  const document = createDocument('const value = 1;\n');
  const originalExecuteCommand = vscode.commands.executeCommand;
  const originalShowInfo = vscode.window.showInformationMessage;
  const seenCommands = [];
  const seenMessages = [];
  vscode.commands.executeCommand = async (commandId, ...args) => {
    seenCommands.push(commandId);
    return originalExecuteCommand.call(vscode.commands, commandId, ...args);
  };
  vscode.window.showInformationMessage = async (message) => {
    seenMessages.push(message);
    return undefined;
  };

  try {
    provider.markManualTrigger(document.uri.fsPath);
    provider.markManualTriggerWindow();
    const first = await provider.provideInlineCompletionItems(
      document,
      { line: 0, character: 0 },
      { triggerKind: 1 },
      { isCancellationRequested: false },
    );

    const second = await provider.provideInlineCompletionItems(
      document,
      { line: 0, character: 0 },
      { triggerKind: 1 },
      { isCancellationRequested: false },
    );

    assert.deepEqual(first, []);
    assert.deepEqual(second, [{ insertText: 'hotkey-second-pass' }]);
    assert.equal(callCount, 3);
    assert.ok(seenCommands.includes('editor.action.inlineSuggest.trigger'));
    assert.deepEqual(seenMessages, []);
  } finally {
    vscode.commands.executeCommand = originalExecuteCommand;
    vscode.window.showInformationMessage = originalShowInfo;
  }
});

test('InlineCompletionProvider hotkey supersedes in-flight completion for unchanged context', async () => {
  let callCount = 0;
  let firstStartedResolve;
  const firstStarted = new Promise((resolve) => {
    firstStartedResolve = resolve;
  });

  const aiProvider = {
    async *streamCompletion(_request, signal) {
      callCount += 1;
      if (callCount === 1 && firstStartedResolve) {
        firstStartedResolve();
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
      if (signal.aborted) {
        throw new Error('Request cancelled');
      }
      yield { text: 'shared-hotkey', done: false };
      yield { text: '', done: true };
    },
  };

  const provider = new InlineCompletionProvider(aiProvider, new CancellationManager(), {
    triggerMode: 'hotkey',
    debounceMs: 0,
    hotkeySemanticRetryEnabled: false,
    maxLatencyMs: 1000,
    context: {
      maxBeforeLines: 200,
      maxAfterLines: 20,
      maxContextChars: 12000,
      maxFileLines: 5000,
    },
  });

  const document = createDocument('const value = 1;\n');
  provider.markManualTriggerWindow();
  const firstPromise = provider.provideInlineCompletionItems(
    document,
    { line: 1, character: 0 },
    { triggerKind: 1 },
    { isCancellationRequested: false },
  );

  await firstStarted;

  provider.markManualTriggerWindow();
  const secondPromise = provider.provideInlineCompletionItems(
    document,
    { line: 1, character: 0 },
    { triggerKind: 1 },
    { isCancellationRequested: false },
  );

  const [first, second] = await Promise.all([firstPromise, secondPromise]);
  assert.equal(callCount, 2);
  assert.deepEqual(first, []);
  assert.deepEqual(second, [{ insertText: 'shared-hotkey' }]);
});

test('InlineCompletionProvider does not serve automatic trigger when hotkey mark exists', async () => {
  let callCount = 0;
  const aiProvider = {
    async *streamCompletion() {
      callCount += 1;
      yield { text: 'manual-hotkey', done: false };
      yield { text: '', done: true };
    },
  };

  const provider = new InlineCompletionProvider(aiProvider, new CancellationManager(), {
    triggerMode: 'hotkey',
    debounceMs: 0,
    hotkeySemanticRetryEnabled: false,
    context: {
      maxBeforeLines: 200,
      maxAfterLines: 20,
      maxContextChars: 12000,
      maxFileLines: 5000,
    },
  });

  const document = createDocument('const value = 1;\n');
  provider.markManualTrigger(document.uri.fsPath);

  const automatic = await provider.provideInlineCompletionItems(
    document,
    { line: 0, character: 0 },
    { triggerKind: 0 },
    { isCancellationRequested: false },
  );
  const invoke = await provider.provideInlineCompletionItems(
    document,
    { line: 0, character: 0 },
    { triggerKind: 1 },
    { isCancellationRequested: false },
  );

  assert.deepEqual(automatic, []);
  assert.deepEqual(invoke, [{ insertText: 'manual-hotkey' }]);
  assert.equal(callCount, 1);
});

test('InlineCompletionProvider allows a short burst of manual hotkey requests before consuming the mark', async () => {
  let callCount = 0;
  const aiProvider = {
    async *streamCompletion() {
      callCount += 1;
      yield { text: 'manual-hotkey', done: false };
      yield { text: '', done: true };
    },
  };

  const provider = new InlineCompletionProvider(aiProvider, new CancellationManager(), {
    triggerMode: 'hotkey',
    debounceMs: 0,
    hotkeySemanticRetryEnabled: false,
    context: {
      maxBeforeLines: 200,
      maxAfterLines: 20,
      maxContextChars: 12000,
      maxFileLines: 5000,
    },
  });

  const firstDocument = createDocument('const value = 1;\n');
  const secondDocument = createDocument('const value = 2;\n');
  const thirdDocument = createDocument('const value = 3;\n');
  const fourthDocument = createDocument('const value = 4;\n');
  provider.markManualTrigger(firstDocument.uri.fsPath);

  const first = await provider.provideInlineCompletionItems(
    firstDocument,
    { line: 0, character: 0 },
    { triggerKind: 1 },
    { isCancellationRequested: false },
  );

  const second = await provider.provideInlineCompletionItems(
    secondDocument,
    { line: 0, character: 0 },
    { triggerKind: 1 },
    { isCancellationRequested: false },
  );

  const third = await provider.provideInlineCompletionItems(
    thirdDocument,
    { line: 0, character: 0 },
    { triggerKind: 1 },
    { isCancellationRequested: false },
  );

  const fourth = await provider.provideInlineCompletionItems(
    fourthDocument,
    { line: 0, character: 0 },
    { triggerKind: 1 },
    { isCancellationRequested: false },
  );

  assert.deepEqual(first, [{ insertText: 'manual-hotkey' }]);
  assert.deepEqual(second, [{ insertText: 'manual-hotkey' }]);
  assert.deepEqual(third, [{ insertText: 'manual-hotkey' }]);
  assert.deepEqual(fourth, []);
  assert.equal(callCount, 3);
});

test('InlineCompletionProvider serves invoke trigger when manual hotkey mark exists', async () => {
  let callCount = 0;
  const aiProvider = {
    async *streamCompletion() {
      callCount += 1;
      yield { text: 'manual-invoke', done: false };
      yield { text: '', done: true };
    },
  };

  const provider = new InlineCompletionProvider(aiProvider, new CancellationManager(), {
    triggerMode: 'hotkey',
    debounceMs: 0,
    hotkeySemanticRetryEnabled: false,
    context: {
      maxBeforeLines: 200,
      maxAfterLines: 20,
      maxContextChars: 12000,
      maxFileLines: 5000,
    },
  });

  const document = createDocument('const value = 1;\n');
  provider.markManualTrigger(document.uri.fsPath);

  const result = await provider.provideInlineCompletionItems(
    document,
    { line: 0, character: 0 },
    { triggerKind: 1 },
    { isCancellationRequested: false },
  );

  assert.deepEqual(result, [{ insertText: 'manual-invoke' }]);
  assert.equal(callCount, 1);
});

test('InlineCompletionProvider includes symbol lookup for hotkey full-context requests', async () => {
  const originalExecute = vscode.commands.executeCommand;
  let symbolLookupCalls = 0;
  vscode.commands.executeCommand = async (command) => {
    if (command === 'vscode.executeDocumentSymbolProvider') {
      symbolLookupCalls += 1;
      return [
        {
          name: 'value',
          kind: 13,
          range: { start: { line: 1, character: 0 }, end: { line: 1, character: 15 } },
          selectionRange: { start: { line: 1, character: 0 }, end: { line: 1, character: 15 } },
          children: [],
        },
      ];
    }
    return [];
  };

  const seenRequests = [];
  const aiProvider = {
    async *streamCompletion(request) {
      seenRequests.push(request);
      if (request.context === undefined) {
        yield { text: '', done: true };
        return;
      }
      yield { text: 'hotkey-context', done: false };
      yield { text: '', done: true };
    },
  };

  try {
    const provider = new InlineCompletionProvider(aiProvider, new CancellationManager(), {
      triggerMode: 'hotkey',
      debounceMs: 0,
      maxLatencyMs: 1000,
      hotkeySemanticRetryEnabled: false,
      context: {
        maxBeforeLines: 200,
        maxAfterLines: 20,
        maxContextChars: 12000,
        maxFileLines: 5000,
      },
    });

    provider.markManualTriggerWindow();
    const result = await provider.provideInlineCompletionItems(
      createDocument("import foo from 'bar';\nconst value = 1;\n"),
      { line: 1, character: 0 },
      { triggerKind: 1 },
      { isCancellationRequested: false },
    );

    assert.deepEqual(result, [{ insertText: 'hotkey-context' }]);
    assert.equal(symbolLookupCalls, 1);
    assert.equal(seenRequests.length, 2);
    assert.equal(seenRequests[0].context, undefined, 'expected fast-stage request first');
    const seenRequest = seenRequests[1];
    assert.ok(seenRequest.context, 'expected full-context payload in hotkey mode');
    assert.ok(seenRequest.context.includes('IMPORTS:'), 'expected import context');
    assert.ok(seenRequest.context.includes('CURRENT_SYMBOL: value'), 'expected current symbol in hotkey full-context');
  } finally {
    vscode.commands.executeCommand = originalExecute;
  }
});

test('InlineCompletionProvider adaptively skips hotkey fast-stage after repeated fallback misses', async () => {
  const seenStages = [];
  const aiProvider = {
    async *streamCompletion(request) {
      const stage = typeof request.promptCacheKey === 'string' && request.promptCacheKey.endsWith(':fast')
        ? 'fast'
        : 'full';
      seenStages.push(stage);
      if (stage === 'fast') {
        yield { text: '', done: true };
        return;
      }
      yield { text: 'adaptive-hotkey', done: false };
      yield { text: '', done: true };
    },
  };

  const provider = new InlineCompletionProvider(aiProvider, new CancellationManager(), {
    triggerMode: 'hotkey',
    debounceMs: 0,
    hotkeySemanticRetryEnabled: false,
    maxLatencyMs: 1000,
    context: {
      maxBeforeLines: 200,
      maxAfterLines: 20,
      maxContextChars: 12000,
      maxFileLines: 5000,
    },
  });

  for (let index = 0; index < 7; index += 1) {
    const document = createDocument(
      `const value_${index} = ${index};\n`,
      `/workspace/adaptive_${index}.ts`,
    );
    provider.markManualTriggerWindow();
    const result = await provider.provideInlineCompletionItems(
      document,
      { line: 0, character: 0 },
      { triggerKind: 1 },
      { isCancellationRequested: false },
    );
    assert.deepEqual(result, [{ insertText: 'adaptive-hotkey' }]);
  }

  const fastStageCalls = seenStages.filter((value) => value === 'fast').length;
  assert.equal(fastStageCalls, 6);
});

test('InlineCompletionProvider skips debounce for invoke triggers in hotkey mode', async () => {
  const debounceMs = 120;
  let firstCallAt = 0;
  const aiProvider = {
    async *streamCompletion() {
      firstCallAt = Date.now();
      yield { text: 'hotkey-no-debounce', done: false };
      yield { text: '', done: true };
    },
  };

  const provider = new InlineCompletionProvider(aiProvider, new CancellationManager(), {
    triggerMode: 'hotkey',
    debounceMs,
    maxLatencyMs: 1000,
    context: {
      maxBeforeLines: 200,
      maxAfterLines: 20,
      maxContextChars: 12000,
      maxFileLines: 5000,
    },
  });

  const startedAt = Date.now();
  provider.markManualTriggerWindow();
  const result = await provider.provideInlineCompletionItems(
    createDocument('const value = 1;\n'),
    { line: 0, character: 0 },
    { triggerKind: 1 },
    { isCancellationRequested: false },
  );

  assert.deepEqual(result, [{ insertText: 'hotkey-no-debounce' }]);
  assert.ok(firstCallAt - startedAt < debounceMs - 40);
});

test('InlineCompletionProvider delays document snapshot until debounce elapses in automatic mode', async () => {
  const debounceMs = 90;
  let getTextCalledAt = 0;
  const aiProvider = {
    async *streamCompletion() {
      yield { text: 'after-debounce', done: false };
      yield { text: '', done: true };
    },
  };

  const provider = new InlineCompletionProvider(aiProvider, new CancellationManager(), {
    triggerMode: 'automatic',
    debounceMs,
    maxLatencyMs: 1000,
    context: {
      maxBeforeLines: 200,
      maxAfterLines: 20,
      maxContextChars: 12000,
      maxFileLines: 5000,
    },
  });

  const startedAt = Date.now();
  const document = {
    uri: { fsPath: '/workspace/file.ts' },
    languageId: 'typescript',
    getText: () => {
      if (!getTextCalledAt) {
        getTextCalledAt = Date.now();
      }
      return 'const value = 1;\n';
    },
  };

  const result = await provider.provideInlineCompletionItems(
    document,
    { line: 0, character: 0 },
    { triggerKind: 0 },
    { isCancellationRequested: false },
  );

  assert.deepEqual(result, [{ insertText: 'after-debounce' }]);
  assert.ok(getTextCalledAt - startedAt >= debounceMs - 25);
});

test('InlineCompletionProvider does not cache raw suggestions that normalize to empty', async () => {
  let callCount = 0;
  const aiProvider = {
    async *streamCompletion() {
      callCount += 1;
      yield { text: 'abc', done: false };
      yield { text: '', done: true };
    },
  };

  const provider = new InlineCompletionProvider(aiProvider, new CancellationManager(), {
    triggerMode: 'automatic',
    debounceMs: 0,
    maxLatencyMs: 1000,
    context: {
      maxBeforeLines: 200,
      maxAfterLines: 20,
      maxContextChars: 12000,
      maxFileLines: 5000,
    },
  });

  const document = createDocument('abc');
  const position = { line: 0, character: 0 };
  const token = { isCancellationRequested: false };

  const first = await provider.provideInlineCompletionItems(
    document,
    position,
    { triggerKind: 0 },
    token,
  );
  const second = await provider.provideInlineCompletionItems(
    document,
    position,
    { triggerKind: 0 },
    token,
  );

  assert.deepEqual(first, []);
  assert.deepEqual(second, []);
  assert.equal(callCount, 2);
});

test('InlineCompletionProvider repairs Python splitlines return completion for str return type', async () => {
  const aiProvider = {
    async *streamCompletion() {
      yield { text: '())', done: false };
      yield { text: '', done: true };
    },
  };

  const provider = new InlineCompletionProvider(aiProvider, new CancellationManager(), {
    triggerMode: 'automatic',
    debounceMs: 0,
    maxLatencyMs: 1000,
    context: {
      maxBeforeLines: 200,
      maxAfterLines: 20,
      maxContextChars: 12000,
      maxFileLines: 5000,
    },
  });

  const text = [
    'def quick_check() -> str:',
    '    text = build_report(METRICS)',
    '    return text.splitlines(',
  ].join('\n');
  const document = {
    uri: { fsPath: '/workspace/file.py' },
    languageId: 'python',
    getText: () => text,
  };

  const result = await provider.provideInlineCompletionItems(
    document,
    { line: 2, character: '    return text.splitlines('.length },
    { triggerKind: 0 },
    { isCancellationRequested: false },
  );

  assert.deepEqual(result, [{ insertText: ')[0]' }]);
});
