require('./helpers/registerVscode.js');

const test = require('node:test');
const assert = require('node:assert/strict');
const vscode = require('vscode');

const {
  buildExtraContext,
  RecencyContextStore,
} = require('../out/completion/contextEnrichment.js');

function createDocument(text, filePath = '/workspace/file.ts') {
  return {
    uri: { fsPath: filePath, toString: () => filePath },
    languageId: 'typescript',
    getText: () => text,
  };
}

test('buildExtraContext includes imports and current symbol', async () => {
  const text = "import foo from 'foo';\nconst value = 1;\n";
  const document = createDocument(text);
  const originalExecute = vscode.commands.executeCommand;

  vscode.commands.executeCommand = async () => [
    {
      name: 'value',
      kind: 13,
      range: { start: { line: 1, character: 0 }, end: { line: 1, character: 15 } },
      selectionRange: { start: { line: 1, character: 0 }, end: { line: 1, character: 15 } },
      children: [],
    },
  ];

  try {
    const extra = await buildExtraContext(
      document,
      { line: 1, character: 5 },
      text,
      [],
      { maxChars: 1000 },
    );

    assert.ok(extra.includes('IMPORTS:'), 'missing import section');
    assert.ok(extra.includes("import foo from 'foo';"));
    assert.ok(extra.includes('CURRENT_SYMBOL: value'));
    assert.ok(!extra.includes('RECENT_CONTEXT:'), 'recency should be omitted when no recent files exist');
  } finally {
    vscode.commands.executeCommand = originalExecute;
  }
});

test('buildExtraContext includes one recent file context by default', async () => {
  const store = new RecencyContextStore({ maxEntries: 2 });
  store.recordSnapshot(
    { text: 'alpha', languageId: 'typescript', filePath: '/workspace/a.ts' },
    { line: 0, character: 0 },
  );
  store.recordSnapshot(
    { text: 'beta', languageId: 'typescript', filePath: '/workspace/b.ts' },
    { line: 0, character: 0 },
  );

  const document = createDocument('import x from "y";\n', '/workspace/current.ts');
  const extra = await buildExtraContext(
    document,
    { line: 0, character: 0 },
    document.getText(),
    store.getRecentEntries('/workspace/current.ts'),
    { maxChars: 1000 },
  );

  assert.ok(extra.includes('IMPORTS:'), 'missing import section');
  assert.ok(extra.includes('RECENT_CONTEXT:'), 'recency should be included by default');
  assert.ok(extra.includes('FILE: b.ts'), 'expected most recent file in context');
  assert.ok(!extra.includes('FILE: a.ts'), 'expected default limit of one recent file');
});

test('buildExtraContext includes recent file context', async () => {
  const store = new RecencyContextStore({ maxEntries: 2 });
  store.recordSnapshot(
    { text: 'alpha', languageId: 'typescript', filePath: '/workspace/a.ts' },
    { line: 0, character: 0 },
  );
  store.recordSnapshot(
    { text: 'beta', languageId: 'typescript', filePath: '/workspace/b.ts' },
    { line: 0, character: 0 },
  );

  const document = createDocument('import x from "y";\n', '/workspace/current.ts');
  const extra = await buildExtraContext(
    document,
    { line: 0, character: 0 },
    document.getText(),
    store.getRecentEntries('/workspace/current.ts'),
    { maxRecentFiles: 1, maxChars: 1000 },
  );

  assert.ok(extra.includes('RECENT_CONTEXT:'), 'missing recent context');
  assert.ok(extra.includes('FILE: b.ts'), 'expected most recent file in context');
});

test('buildExtraContext can skip current symbol lookup', async () => {
  const text = "import foo from 'foo';\nconst value = 1;\n";
  const document = createDocument(text);
  const originalExecute = vscode.commands.executeCommand;
  let symbolLookupCalls = 0;

  vscode.commands.executeCommand = async (command) => {
    if (command === 'vscode.executeDocumentSymbolProvider') {
      symbolLookupCalls += 1;
    }
    return [];
  };

  try {
    const extra = await buildExtraContext(
      document,
      { line: 1, character: 5 },
      text,
      [],
      { includeCurrentSymbol: false, maxChars: 1000 },
    );

    assert.ok(extra.includes('IMPORTS:'), 'missing import section');
    assert.ok(!extra.includes('CURRENT_SYMBOL:'), 'symbol should be omitted');
    assert.equal(symbolLookupCalls, 0);
  } finally {
    vscode.commands.executeCommand = originalExecute;
  }
});

test('buildExtraContext respects symbol lookup timeout override', async () => {
  const text = "import foo from 'foo';\nconst value = 1;\n";
  const document = createDocument(text, '/workspace/timeout.ts');
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
    const startedAt = Date.now();
    const extra = await buildExtraContext(
      document,
      { line: 1, character: 5 },
      text,
      [],
      { maxChars: 1000, symbolLookupTimeoutMs: 5 },
    );

    assert.ok(extra.includes('IMPORTS:'), 'missing import section');
    assert.ok(!extra.includes('CURRENT_SYMBOL:'), 'timed out symbol should be omitted');
    assert.equal(symbolLookupCalls, 1);
    assert.ok(Date.now() - startedAt < 80);
  } finally {
    vscode.commands.executeCommand = originalExecute;
  }
});

test('RecencyContextStore.recordContext stores provided context without rebuilding snapshot', () => {
  const store = new RecencyContextStore({ maxEntries: 2 });
  store.recordContext({
    filePath: '/workspace/alpha.ts',
    languageId: 'typescript',
    prefix: 'const alpha = run(',
    suffix: ');',
    selection: '',
  });
  store.recordContext({
    filePath: '/workspace/beta.ts',
    languageId: 'typescript',
    prefix: 'const beta = run(',
    suffix: ');',
    selection: '',
  });

  const recent = store.getRecentEntries('/workspace/current.ts');
  assert.equal(recent.length, 2);
  assert.equal(recent[0].filePath, '/workspace/beta.ts');
  assert.equal(recent[0].prefix, 'const beta = run(');
  assert.equal(recent[1].filePath, '/workspace/alpha.ts');
});
