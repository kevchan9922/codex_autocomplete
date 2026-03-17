require('./helpers/registerVscode.js');

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildCodexRequestBodyObject,
  CodexProvider,
} = require('../out/api/codexProvider.js');
const { getCodexLogLevel, setCodexLogLevel } = require('../out/logging/codexLogger.js');

class FakeHttpClient {
  constructor(responses) {
    this.responses = responses;
    this.requests = [];
  }

  async request(request) {
    this.requests.push(request);
    const response = this.responses[Math.min(this.requests.length - 1, this.responses.length - 1)];
    return {
      status: response.status,
      ok: response.status >= 200 && response.status < 300,
      stream: this.#streamChunks(response.chunks || []),
      headers: response.headers,
    };
  }

  async *#streamChunks(chunks) {
    for (const chunk of chunks) {
      yield chunk;
    }
  }
}

function parsePromptPayload(requestBody) {
  const body = JSON.parse(requestBody);
  const promptText = body.input?.[0]?.content?.[0]?.text;
  assert.equal(typeof promptText, 'string', 'missing input prompt text');
  return {
    body,
    promptText,
    promptPayload: JSON.parse(promptText),
  };
}

test('CodexProvider streams chunks from server-sent events', async () => {
  const httpClient = new FakeHttpClient([
    {
      status: 200,
      chunks: ['data: {"delta":"Hel"}\n\n', 'data: {"delta":"lo"}\n\n', 'data: [DONE]\n\n'],
    },
  ]);

  const provider = new CodexProvider({
    endpoint: 'https://example.test',
    model: 'codex-test',
    tokenManager: { getAccessToken: async () => 'token' },
    httpClient,
  });

  const controller = new AbortController();
  const chunks = [];

  for await (const chunk of provider.streamCompletion(
    {
      prefix: 'p',
      suffix: 's',
      languageId: 'ts',
      filePath: '/tmp/file.ts',
    },
    controller.signal,
  )) {
    chunks.push(chunk);
  }

  assert.deepEqual(chunks, [
    { text: 'Hel', done: false },
    { text: 'lo', done: false },
    { text: '', done: true },
  ]);
});

test('CodexProvider reports request telemetry through onTelemetry callback before terminal done chunk', async () => {
  const httpClient = new FakeHttpClient([
    {
      status: 200,
      headers: {
        'x-request-id': 'req_test_123',
        'openai-processing-ms': '66',
      },
      chunks: ['data: {"delta":"ok"}\n\n', 'data: [DONE]\n\n'],
    },
  ]);

  const provider = new CodexProvider({
    endpoint: 'https://api.openai.com/v1/responses',
    model: 'codex-test',
    tokenManager: { getAccessToken: async () => 'token' },
    httpClient,
  });

  let telemetry;
  const chunks = [];
  for await (const chunk of provider.streamCompletion(
    {
      prefix: 'return ',
      suffix: '',
      languageId: 'python',
      filePath: '/tmp/file.py',
      onTelemetry(value) {
        telemetry = value;
      },
    },
    new AbortController().signal,
  )) {
    chunks.push(chunk);
    if (chunk.done) {
      break;
    }
  }

  assert.deepEqual(chunks, [
    { text: 'ok', done: false },
    { text: '', done: true },
  ]);
  assert.match(String(telemetry.preAttemptMs ?? ''), /^\d+$/);
  assert.equal(telemetry.responseStatus, 200);
  assert.equal(telemetry.requestId, 'req_test_123');
  assert.equal(telemetry.serverProcessingMs, 66);
  assert.match(String(telemetry.headersLatencyMs ?? ''), /^\d+$/);
  assert.match(String(telemetry.firstRawChunkMs ?? ''), /^\d+$/);
  assert.match(String(telemetry.firstPayloadMs ?? ''), /^\d+$/);
  assert.match(String(telemetry.firstTextMs ?? ''), /^\d+$/);
  assert.match(String(telemetry.streamDurationMs ?? ''), /^\d+$/);
});


test('CodexProvider ignores non-JSON SSE payloads and continues streaming', async () => {
  const httpClient = new FakeHttpClient([
    {
      status: 200,
      chunks: [
        'data: [KEEPALIVE]\n\n',
        'data: {"type":"response.output_text.delta","delta":"ok"}\n\n',
        'data: [DONE]\n\n',
      ],
    },
  ]);

  const provider = new CodexProvider({
    endpoint: 'https://api.openai.com/v1/responses',
    model: 'codex-test',
    tokenManager: { getAccessToken: async () => 'token' },
    httpClient,
  });

  const chunks = [];
  for await (const chunk of provider.streamCompletion(
    {
      prefix: 'x = ',
      suffix: '\nprint(x)',
      languageId: 'python',
      filePath: '/tmp/file.py',
    },
    new AbortController().signal,
  )) {
    chunks.push(chunk);
  }

  assert.deepEqual(chunks, [
    { text: 'ok', done: false },
    { text: '', done: true },
  ]);
});

test('CodexProvider extracts text from output_item/content_part events', async () => {
  const httpClient = new FakeHttpClient([
    {
      status: 200,
      chunks: [
        'data: {"type":"response.output_item.added","item":{"type":"message","content":[{"type":"output_text","text":"hel"}]}}\n\n',
        'data: {"type":"response.content_part.added","part":{"type":"output_text","text":"lo"}}\n\n',
        'data: {"type":"response.content_part.added","part":{"type":"output_text","text":{"value":"!"}}}\n\n',
        'data: {"type":"response.completed"}\n\n',
      ],
    },
  ]);

  const provider = new CodexProvider({
    endpoint: 'https://chatgpt.com/backend-api/codex/responses',
    model: 'codex-test',
    tokenManager: { getAccessToken: async () => 'token' },
    httpClient,
  });

  const chunks = [];
  for await (const chunk of provider.streamCompletion(
    {
      prefix: 'return ',
      suffix: '',
      languageId: 'python',
      filePath: '/tmp/file.py',
    },
    new AbortController().signal,
  )) {
    chunks.push(chunk);
  }

  assert.deepEqual(chunks, [
    { text: 'hel', done: false },
    { text: 'lo', done: false },
    { text: '!', done: false },
    { text: '', done: true },
  ]);
});

test('CodexProvider extracts nested output_text delta payloads', async () => {
  const httpClient = new FakeHttpClient([
    {
      status: 200,
      chunks: [
        'data: {"type":"response.created"}\n\n',
        'data: {"type":"response.output_text.delta","delta":{"value":"he"}}\n\n',
        'data: {"type":"response.output_text.delta","delta":[{"value":"llo"}]}\n\n',
        'data: {"type":"response.completed"}\n\n',
      ],
    },
  ]);

  const provider = new CodexProvider({
    endpoint: 'https://api.openai.com/v1/responses',
    model: 'codex-test',
    tokenManager: { getAccessToken: async () => 'token' },
    httpClient,
  });

  const chunks = [];
  for await (const chunk of provider.streamCompletion(
    {
      prefix: 'return ',
      suffix: '',
      languageId: 'python',
      filePath: '/tmp/file.py',
    },
    new AbortController().signal,
  )) {
    chunks.push(chunk);
  }

  assert.deepEqual(chunks, [
    { text: 'he', done: false },
    { text: 'llo', done: false },
    { text: '', done: true },
  ]);
});

test('CodexProvider does not double-count terminal output_text.done snapshots after deltas', async () => {
  const httpClient = new FakeHttpClient([
    {
      status: 200,
      chunks: [
        'data: {"type":"response.output_text.delta","delta":"he"}\n\n',
        'data: {"type":"response.output_text.delta","delta":"llo"}\n\n',
        'data: {"type":"response.output_text.done","text":"hello"}\n\n',
      ],
    },
  ]);

  const provider = new CodexProvider({
    endpoint: 'https://api.openai.com/v1/responses',
    model: 'codex-test',
    tokenManager: { getAccessToken: async () => 'token' },
    httpClient,
  });

  const chunks = [];
  for await (const chunk of provider.streamCompletion(
    {
      prefix: 'return ',
      suffix: '',
      languageId: 'python',
      filePath: '/tmp/file.py',
    },
    new AbortController().signal,
  )) {
    chunks.push(chunk);
  }

  assert.deepEqual(chunks, [
    { text: 'he', done: false },
    { text: 'llo', done: false },
    { text: '', done: true },
  ]);
});

test('CodexProvider computes snapshot deltas against already emitted text from typed deltas', async () => {
  const httpClient = new FakeHttpClient([
    {
      status: 200,
      chunks: [
        'data: {"type":"response.output_text.delta","delta":"he"}\n\n',
        'data: {"type":"response.in_progress","response":{"output":[{"type":"message","content":[{"type":"output_text","text":"hello"}]}]}}\n\n',
        'data: {"type":"response.completed","response":{"output":[{"type":"message","content":[{"type":"output_text","text":"hello"}]}]}}\n\n',
      ],
    },
  ]);

  const provider = new CodexProvider({
    endpoint: 'https://api.openai.com/v1/responses',
    model: 'codex-test',
    tokenManager: { getAccessToken: async () => 'token' },
    httpClient,
  });

  const chunks = [];
  for await (const chunk of provider.streamCompletion(
    {
      prefix: 'return ',
      suffix: '',
      languageId: 'python',
      filePath: '/tmp/file.py',
    },
    new AbortController().signal,
  )) {
    chunks.push(chunk);
  }

  assert.deepEqual(chunks, [
    { text: 'he', done: false },
    { text: 'llo', done: false },
    { text: '', done: true },
  ]);
});

test('CodexProvider extracts snapshot text from response.in_progress and emits deltas', async () => {
  const httpClient = new FakeHttpClient([
    {
      status: 200,
      chunks: [
        'data: {"type":"response.in_progress","response":{"output":[{"type":"message","content":[{"type":"output_text","text":"hel"}]}]}}\n\n',
        'data: {"type":"response.in_progress","response":{"output":[{"type":"message","content":[{"type":"output_text","text":"hello"}]}]}}\n\n',
        'data: {"type":"response.completed","response":{"output":[{"type":"message","content":[{"type":"output_text","text":"hello"}]}]}}\n\n',
      ],
    },
  ]);

  const provider = new CodexProvider({
    endpoint: 'https://chatgpt.com/backend-api/codex/responses',
    model: 'codex-test',
    tokenManager: { getAccessToken: async () => 'token' },
    httpClient,
  });

  const chunks = [];
  for await (const chunk of provider.streamCompletion(
    {
      prefix: 'return ',
      suffix: '',
      languageId: 'python',
      filePath: '/tmp/file.py',
    },
    new AbortController().signal,
  )) {
    chunks.push(chunk);
  }

  assert.deepEqual(chunks, [
    { text: 'hel', done: false },
    { text: 'lo', done: false },
    { text: '', done: true },
  ]);
});

test('CodexProvider emits progress for metadata-only typed events until text arrives', async () => {
  const httpClient = new FakeHttpClient([
    {
      status: 200,
      chunks: [
        'data: {"type":"response.created"}\n\n',
        'data: {"type":"response.in_progress"}\n\n',
        'data: {"type":"response.output_item.added","item":{"type":"message","content":[]}}\n\n',
        'data: {"type":"response.output_text.delta","delta":"ok"}\n\n',
        'data: {"type":"response.completed"}\n\n',
      ],
    },
  ]);

  const provider = new CodexProvider({
    endpoint: 'https://chatgpt.com/backend-api/codex/responses',
    model: 'codex-test',
    tokenManager: { getAccessToken: async () => 'token' },
    httpClient,
  });

  const chunks = [];
  for await (const chunk of provider.streamCompletion(
    {
      prefix: 'return ',
      suffix: '',
      languageId: 'python',
      filePath: '/tmp/file.py',
    },
    new AbortController().signal,
  )) {
    chunks.push(chunk);
  }

  assert.deepEqual(chunks, [
    { text: '', done: false, progress: true },
    { text: '', done: false, progress: true },
    { text: 'ok', done: false },
    { text: '', done: true },
  ]);
});

test('CodexProvider emits progress for empty output_text delta events', async () => {
  const httpClient = new FakeHttpClient([
    {
      status: 200,
      chunks: [
        'data: {"type":"response.output_text.delta","delta":""}\n\n',
        'data: {"type":"response.output_text.delta","delta":"ok"}\n\n',
        'data: {"type":"response.completed"}\n\n',
      ],
    },
  ]);

  const provider = new CodexProvider({
    endpoint: 'https://chatgpt.com/backend-api/codex/responses',
    model: 'codex-test',
    tokenManager: { getAccessToken: async () => 'token' },
    httpClient,
  });

  const chunks = [];
  for await (const chunk of provider.streamCompletion(
    {
      prefix: 'return ',
      suffix: '',
      languageId: 'python',
      filePath: '/tmp/file.py',
    },
    new AbortController().signal,
  )) {
    chunks.push(chunk);
  }

  assert.deepEqual(chunks, [
    { text: '', done: false, progress: true },
    { text: 'ok', done: false },
    { text: '', done: true },
  ]);
});

test('CodexProvider logs parsed payload shapes at debug level when typed events never emit text', async () => {
  const httpClient = new FakeHttpClient([
    {
      status: 200,
      chunks: [
        'data: {"type":"response.created"}\n\n',
        'data: {"type":"response.output_item.added","item":{"type":"message","content":[]}}\n\n',
        'data: {"type":"response.completed"}\n\n',
      ],
    },
  ]);

  const provider = new CodexProvider({
    endpoint: 'https://chatgpt.com/backend-api/codex/responses',
    model: 'codex-test',
    tokenManager: { getAccessToken: async () => 'token' },
    httpClient,
  });

  const originalConsoleLog = console.log;
  const originalLogLevel = getCodexLogLevel();
  const logs = [];
  console.log = (...args) => logs.push(args.join(' '));
  setCodexLogLevel('debug');

  try {
    const chunks = [];
    for await (const chunk of provider.streamCompletion(
      {
        prefix: 'return ',
        suffix: '',
        languageId: 'python',
        filePath: '/tmp/file.py',
      },
      new AbortController().signal,
    )) {
      chunks.push(chunk);
    }

    assert.deepEqual(chunks, [
      { text: '', done: false, progress: true },
      { text: '', done: true },
    ]);
  } finally {
    console.log = originalConsoleLog;
    setCodexLogLevel(originalLogLevel);
  }

  assert.ok(
    logs.some((line) => line.includes('stream warning: parsed payloads present but no text chunks emitted')),
  );
  assert.ok(logs.some((line) => line.includes('stream first parsed payload shape')));
  assert.ok(logs.some((line) => line.includes('stream first typed payload shape')));
});

test('CodexProvider retries 429 responses with bounded attempts', async () => {
  const httpClient = new FakeHttpClient([
    { status: 429 },
    { status: 429 },
    { status: 200, chunks: ['data: {"delta":"ok"}\n\n', 'data: [DONE]\n\n'] },
  ]);

  const provider = new CodexProvider({
    endpoint: 'https://example.test',
    model: 'codex-test',
    tokenManager: { getAccessToken: async () => 'token' },
    httpClient,
    baseRetryDelayMs: 1,
    maxRetries: 2,
  });

  const chunks = [];
  for await (const chunk of provider.streamCompletion(
    {
      prefix: 'p',
      suffix: 's',
      languageId: 'ts',
      filePath: '/tmp/file.ts',
    },
    new AbortController().signal,
  )) {
    chunks.push(chunk);
  }

  assert.equal(httpClient.requests.length, 3);
  assert.deepEqual(chunks, [
    { text: 'ok', done: false },
    { text: '', done: true },
  ]);
});

test('CodexProvider uses reduced 429 retries in automatic mode', async () => {
  const httpClient = new FakeHttpClient([
    { status: 429 },
    { status: 429 },
    { status: 200, chunks: ['data: {"delta":"ok"}\n\n', 'data: [DONE]\n\n'] },
  ]);

  const provider = new CodexProvider({
    endpoint: 'https://example.test',
    model: 'codex-test',
    tokenManager: { getAccessToken: async () => 'token' },
    httpClient,
    baseRetryDelayMs: 1,
    maxRetries: 2,
    automaticModeMaxRetries: 1,
  });

  await assert.rejects(async () => {
    for await (const _chunk of provider.streamCompletion(
      {
        prefix: 'p',
        suffix: 's',
        languageId: 'ts',
        filePath: '/tmp/file.ts',
        interactionMode: 'automatic',
      },
      new AbortController().signal,
    )) {
      // no-op
    }
  }, /status 429/i);

  assert.equal(httpClient.requests.length, 2);
});

test('CodexProvider throws when request is aborted during retry wait', async () => {
  const httpClient = new FakeHttpClient([{ status: 429 }]);
  const provider = new CodexProvider({
    endpoint: 'https://example.test',
    model: 'codex-test',
    tokenManager: { getAccessToken: async () => 'token' },
    httpClient,
    baseRetryDelayMs: 20,
    maxRetries: 2,
  });

  const controller = new AbortController();

  await assert.rejects(async () => {
    const task = (async () => {
      for await (const _chunk of provider.streamCompletion(
        {
          prefix: 'p',
          suffix: 's',
          languageId: 'ts',
          filePath: '/tmp/file.ts',
        },
        controller.signal,
      )) {
        // no-op
      }
    })();

    setTimeout(() => controller.abort(), 5);
    await task;
  }, /Request cancelled/);
});

test('CodexProvider does not retry on unauthorized responses', async () => {
  const httpClient = new FakeHttpClient([{ status: 401 }]);
  const provider = new CodexProvider({
    endpoint: 'https://example.test',
    model: 'codex-test',
    tokenManager: { getAccessToken: async () => 'token' },
    httpClient,
    maxRetries: 2,
    baseRetryDelayMs: 1,
  });

  await assert.rejects(async () => {
    for await (const _chunk of provider.streamCompletion(
      {
        prefix: 'p',
        suffix: 's',
        languageId: 'ts',
        filePath: '/tmp/file.ts',
      },
      new AbortController().signal,
    )) {
      // no-op
    }
  }, /unauthorized/i);

  assert.equal(httpClient.requests.length, 1);
});

test('CodexProvider includes API-only fields and compact cursor payload for api.openai.com', async () => {
  const httpClient = new FakeHttpClient([
    { status: 200, chunks: ['data: [DONE]\n\n'] },
  ]);

  const provider = new CodexProvider({
    endpoint: 'https://api.openai.com/v1/responses',
    model: 'codex-test',
    tokenManager: { getAccessToken: async () => 'token' },
    httpClient,
    maxOutputTokens: 64,
    serviceTier: 'priority',
    promptCacheKey: 'from-options',
    promptCacheRetention: '24h',
  });

  for await (const _chunk of provider.streamCompletion(
    {
      prefix: 'planner.add_task(',
      suffix: ')\nreturn x',
      languageId: 'python',
      filePath: '/tmp/file.py',
      serviceTier: 'default',
      promptCacheKey: 'from-request',
      promptCacheRetention: '1h',
      maxOutputTokens: 128,
    },
    new AbortController().signal,
  )) {
    // consume
  }

  assert.equal(httpClient.requests.length, 1);
  const { body, promptPayload } = parsePromptPayload(httpClient.requests[0].body);
  assert.equal(body.max_output_tokens, 128);
  assert.equal(body.service_tier, 'default');
  assert.equal(body.prompt_cache_key, 'from-request');
  assert.equal(body.prompt_cache_retention, '1h');
  assert.deepEqual(body.reasoning, { effort: 'none' });
  assert.deepEqual(body.text, { verbosity: 'low' });
  assert.equal('summary' in body, false);
  assert.equal(promptPayload.schema_version, 'inline_context_v1');
  assert.equal(promptPayload.file_path, '/tmp/file.py');
  assert.equal('selection' in promptPayload, false);
  assert.equal(promptPayload.language, 'python');
  assert.equal(
    promptPayload.context_priority.primary_order,
    'current > prev > next > others',
  );
  assert.equal(promptPayload.cursor_context.line_prefix, 'planner.add_task(');
  assert.equal(promptPayload.cursor_context.line_suffix, ')');
  assert.equal(promptPayload.cursor_context.indent, '');
  assert.equal(promptPayload.cursor_context.call_context, 'planner.add_task');
  assert.deepEqual(promptPayload.priority_context, {
    current: 'planner.add_task()',
    prev: null,
    next: 'return x',
  });
  assert.deepEqual(promptPayload.ordered_context, [
    { distance: 0, text: 'planner.add_task(', side: 'prefix' },
    { distance: 1, text: ')', side: 'suffix' },
    { distance: 2, text: 'return x', side: 'suffix' },
  ]);
  assert.equal('task' in promptPayload, false);
});

test('CodexProvider preserves empty same-line suffix for whitespace-only current line', async () => {
  const httpClient = new FakeHttpClient([
    { status: 200, chunks: ['data: [DONE]\n\n'] },
  ]);

  const provider = new CodexProvider({
    endpoint: 'https://api.openai.com/v1/responses',
    model: 'codex-test',
    tokenManager: { getAccessToken: async () => 'token' },
    httpClient,
  });

  for await (const _chunk of provider.streamCompletion(
    {
      prefix: 'def run() -> str:\n    message = f"User {user[\'name\']\n    ',
      suffix: '    return message\n',
      linePrefix: '    ',
      lineSuffix: '',
      languageId: 'python',
      filePath: '/tmp/file.py',
    },
    new AbortController().signal,
  )) {
    // consume
  }

  assert.equal(httpClient.requests.length, 1);
  const { promptPayload } = parsePromptPayload(httpClient.requests[0].body);
  assert.equal(promptPayload.cursor_context.line_prefix, '    ');
  assert.equal(promptPayload.cursor_context.line_suffix, '');
  assert.deepEqual(promptPayload.priority_context, {
    current: '    ',
    prev: '    message = f"User {user[\'name\']',
    next: '    return message',
  });
  assert.equal(promptPayload.ordered_context[1]?.text, '    message = f"User {user[\'name\']');
  assert.equal(promptPayload.ordered_context[2]?.text, '    return message');
});

test('CodexProvider preserves blank neighbors in priority and ordered context', async () => {
  const httpClient = new FakeHttpClient([
    { status: 200, chunks: ['data: [DONE]\n\n'] },
  ]);

  const provider = new CodexProvider({
    endpoint: 'https://api.openai.com/v1/responses',
    model: 'codex-test',
    tokenManager: { getAccessToken: async () => 'token' },
    httpClient,
  });

  for await (const _chunk of provider.streamCompletion(
    {
      prefix: 'def run() -> str:\n    value = format_name(user)\n\n    ',
      suffix: '\n\n    return value\n',
      linePrefix: '    ',
      lineSuffix: '',
      languageId: 'python',
      filePath: '/tmp/file.py',
    },
    new AbortController().signal,
  )) {
    // consume
  }

  const { promptPayload } = parsePromptPayload(httpClient.requests[0].body);
  assert.deepEqual(promptPayload.priority_context, {
    current: '    ',
    prev: '',
    next: '',
  });
  assert.deepEqual(promptPayload.ordered_context.slice(0, 4), [
    { distance: 0, text: '    ', side: 'prefix' },
    { distance: -1, text: '', side: 'prefix' },
    { distance: 1, text: '', side: 'suffix' },
    { distance: -2, text: '    value = format_name(user)', side: 'prefix' },
  ]);
});

test('CodexProvider preserves tabs and spaces in cursor and line context payload', async () => {
  const httpClient = new FakeHttpClient([
    { status: 200, chunks: ['data: [DONE]\n\n'] },
  ]);

  const provider = new CodexProvider({
    endpoint: 'https://api.openai.com/v1/responses',
    model: 'codex-test',
    tokenManager: { getAccessToken: async () => 'token' },
    httpClient,
  });

  for await (const _chunk of provider.streamCompletion(
    {
      prefix: 'function run() {\n\t  const msg = format(user);\n\t  ',
      suffix: 'return msg;\n}',
      linePrefix: '\t  ',
      lineSuffix: '',
      languageId: 'javascript',
      filePath: '/tmp/file.js',
    },
    new AbortController().signal,
  )) {
    // consume
  }

  const { promptPayload } = parsePromptPayload(httpClient.requests[0].body);
  assert.equal(promptPayload.cursor_context.line_prefix, '\t  ');
  assert.equal(promptPayload.cursor_context.indent, '\t  ');
  assert.deepEqual(promptPayload.priority_context, {
    current: '\t  ',
    prev: '\t  const msg = format(user);',
    next: 'return msg;',
  });
  assert.deepEqual(promptPayload.ordered_context.slice(0, 3), [
    { distance: 0, text: '\t  ', side: 'prefix' },
    { distance: -1, text: '\t  const msg = format(user);', side: 'prefix' },
    { distance: 1, text: 'return msg;', side: 'suffix' },
  ]);
});



test('CodexProvider sends markdown document context as markdown language suggestions', async () => {
  const httpClient = new FakeHttpClient([
    { status: 200, chunks: ['data: {"delta":"# Summary"}\n\n', 'data: [DONE]\n\n'] },
  ]);

  const provider = new CodexProvider({
    endpoint: 'https://api.openai.com/v1/responses',
    model: 'codex-test',
    tokenManager: { getAccessToken: async () => 'token' },
    httpClient,
  });

  const chunks = [];
  for await (const chunk of provider.streamCompletion(
    {
      prefix: '## Notes\n- item one\n- ',
      suffix: '\n\n## Next',
      linePrefix: '- ',
      lineSuffix: '',
      languageId: 'markdown',
      filePath: '/tmp/README.md',
    },
    new AbortController().signal,
  )) {
    chunks.push(chunk);
  }

  assert.deepEqual(chunks, [
    { text: '# Summary', done: false },
    { text: '', done: true },
  ]);

  const { promptPayload } = parsePromptPayload(httpClient.requests[0].body);
  assert.equal(promptPayload.language, 'markdown');
  assert.equal(promptPayload.cursor_context.line_prefix, '- ');
  assert.equal(promptPayload.ordered_context[1]?.text, '- item one');
  assert.equal(promptPayload.ordered_context[2]?.text, '');
  assert.equal(promptPayload.ordered_context[3]?.text, '## Notes');
  assert.equal(promptPayload.ordered_context[4]?.text, '');
  assert.equal(promptPayload.ordered_context[5]?.text, '## Next');
});

test('CodexProvider sends plaintext document context for text file suggestions', async () => {
  const httpClient = new FakeHttpClient([
    { status: 200, chunks: ['data: {"delta":"todo"}\n\n', 'data: [DONE]\n\n'] },
  ]);

  const provider = new CodexProvider({
    endpoint: 'https://api.openai.com/v1/responses',
    model: 'codex-test',
    tokenManager: { getAccessToken: async () => 'token' },
    httpClient,
  });

  const chunks = [];
  for await (const chunk of provider.streamCompletion(
    {
      prefix: 'Meeting notes:\n- follow up with',
      suffix: '\n- send summary',
      languageId: 'plaintext',
      filePath: '/tmp/notes.txt',
    },
    new AbortController().signal,
  )) {
    chunks.push(chunk);
  }

  assert.deepEqual(chunks, [
    { text: 'todo', done: false },
    { text: '', done: true },
  ]);

  const { promptPayload } = parsePromptPayload(httpClient.requests[0].body);
  assert.equal(promptPayload.language, 'plaintext');
  assert.equal(promptPayload.cursor_context.line_prefix, '- follow up with');
  assert.deepEqual(promptPayload.ordered_context, [
    { distance: 0, text: '- follow up with', side: 'prefix' },
    { distance: -1, text: 'Meeting notes:', side: 'prefix' },
    { distance: 1, text: '', side: 'suffix' },
    { distance: 2, text: '- send summary', side: 'suffix' },
  ]);
});

test('CodexProvider uses same compact prompt payload for automatic and hotkey modes', async () => {
  const httpClient = new FakeHttpClient([
    { status: 200, chunks: ['data: [DONE]\n\n'] },
    { status: 200, chunks: ['data: [DONE]\n\n'] },
  ]);

  const provider = new CodexProvider({
    endpoint: 'https://api.openai.com/v1/responses',
    model: 'codex-test',
    tokenManager: { getAccessToken: async () => 'token' },
    httpClient,
  });

  const prefix = Array.from({ length: 120 }, (_item, index) => `prefix_${index}`).join('\n');
  const suffix = Array.from({ length: 80 }, (_item, index) => `suffix_${index}`).join('\n');
  const extraContext = 'x'.repeat(1200);

  for await (const _chunk of provider.streamCompletion(
    {
      prefix,
      suffix,
      languageId: 'typescript',
      filePath: '/tmp/file.ts',
      context: extraContext,
      interactionMode: 'automatic',
    },
    new AbortController().signal,
  )) {
    // consume
  }
  for await (const _chunk of provider.streamCompletion(
    {
      prefix,
      suffix,
      languageId: 'typescript',
      filePath: '/tmp/file.ts',
      context: extraContext,
      interactionMode: 'hotkey',
    },
    new AbortController().signal,
  )) {
    // consume
  }

  const automaticParsed = parsePromptPayload(httpClient.requests[0].body);
  const hotkeyParsed = parsePromptPayload(httpClient.requests[1].body);
  assert.deepEqual(hotkeyParsed.promptPayload, automaticParsed.promptPayload);
  assert.equal(automaticParsed.promptPayload.schema_version, 'inline_context_v1');
  assert.equal(automaticParsed.promptPayload.file_path, '/tmp/file.ts');
  assert.equal(automaticParsed.promptPayload.language, 'typescript');
  assert.equal(automaticParsed.promptPayload.extra_context.length, 800, 'missing compact extra context');
  assert.equal(automaticParsed.promptPayload.ordered_context.length, 68);
  assert.deepEqual(automaticParsed.promptPayload.priority_context, {
    current: 'prefix_119suffix_0',
    prev: 'prefix_118',
    next: 'suffix_1',
  });
  assert.equal(
    automaticParsed.promptPayload.context_priority.primary_order,
    'current > prev > next > others',
  );
  assert.deepEqual(automaticParsed.promptPayload.ordered_context.slice(0, 4), [
    { distance: 0, text: 'prefix_119', side: 'prefix' },
    { distance: -1, text: 'prefix_118', side: 'prefix' },
    { distance: 1, text: 'suffix_0', side: 'suffix' },
    { distance: -2, text: 'prefix_117', side: 'prefix' },
  ]);
  assert.deepEqual(automaticParsed.promptPayload.ordered_context.slice(-3), [
    { distance: -45, text: 'prefix_74', side: 'prefix' },
    { distance: -46, text: 'prefix_73', side: 'prefix' },
    { distance: -47, text: 'prefix_72', side: 'prefix' },
  ]);
  assert.equal('task' in automaticParsed.promptPayload, false);
  assert.ok(automaticParsed.promptText.length < 5000, `prompt was larger than expected: ${automaticParsed.promptText.length}`);
});

test('CodexProvider adds scope context for long Python scopes outside the compact prefix window', () => {
  const innerLines = Array.from(
    { length: 56 },
    (_item, index) => `    helper_${index} = step_${index}(value)`,
  );
  const requestBody = JSON.stringify(buildCodexRequestBodyObject(
    {
      prefix: [
        'import os',
        '',
        'def build_status(value: str) -> str:',
        ...innerLines,
        '    return result_val',
      ].join('\n'),
      suffix: '\n',
      linePrefix: '    return result_val',
      lineSuffix: '',
      languageId: 'python',
      filePath: '/tmp/file.py',
    },
    {
      endpoint: 'https://api.openai.com/v1/responses',
      model: 'codex-test',
      instructions: 'Return only code',
    },
  ));

  const { promptPayload } = parsePromptPayload(requestBody);
  assert.equal(
    promptPayload.ordered_context.some((entry) => entry.text === 'def build_status(value: str) -> str:'),
    false,
  );
  assert.deepEqual(promptPayload.scope_context, {
    strategy: 'python_scope',
    header: 'def build_status(value: str) -> str:',
  });
});

test('CodexProvider promotes shortest partial-token continuation lines in ordered context', async () => {
  const requestBody = JSON.stringify(buildCodexRequestBodyObject(
    {
      prefix: [
        'def near_duplicate_report_pick() -> str:',
        '    report_text = report',
        '    report_summary = report.splitlines()[0]',
        '    return report_',
      ].join('\n'),
      suffix: '\n',
      linePrefix: '    return report_',
      lineSuffix: '',
      languageId: 'python',
      filePath: '/tmp/file.py',
    },
    {
      endpoint: 'https://api.openai.com/v1/responses',
      model: 'codex-test',
      instructions: 'Return only code',
    },
  ));

  const { promptPayload } = parsePromptPayload(requestBody);
  assert.deepEqual(promptPayload.ordered_context.slice(0, 3), [
    { distance: 0, text: '    return report_', side: 'prefix' },
    { distance: -2, text: '    report_text = report', side: 'prefix' },
    { distance: -1, text: '    report_summary = report.splitlines()[0]', side: 'prefix' },
  ]);
});

test('CodexProvider annotates template interpolation closure tasks in prompt payload', () => {
  const requestBody = JSON.stringify(buildCodexRequestBodyObject(
    {
      prefix: [
        'export function runTemplateLiteralCase(invoice: { id: string; total: number }): string {',
        '  const label = `Invoice ${invoice.id',
      ].join('\n'),
      suffix: '\n  return label;\n}\n',
      linePrefix: '  const label = `Invoice ${invoice.id',
      lineSuffix: '',
      languageId: 'typescript',
      filePath: '/tmp/file.ts',
    },
    {
      endpoint: 'https://api.openai.com/v1/responses',
      model: 'codex-test',
      instructions: 'Return only code',
    },
  ));

  const { promptPayload } = parsePromptPayload(requestBody);
  assert.equal(promptPayload.task, 'close_template_interpolation');
});

test('CodexProvider annotates split-call completion tasks in prompt payload', () => {
  const requestBody = JSON.stringify(buildCodexRequestBodyObject(
    {
      prefix: [
        'export function runChainCase(lines: string[]): string {',
        '  const first = lines.map((line) => line.trim()).filter(Boolean).join(", ").split(',
      ].join('\n'),
      suffix: '\n  return first;\n}\n',
      linePrefix: '  const first = lines.map((line) => line.trim()).filter(Boolean).join(", ").split(',
      lineSuffix: '',
      languageId: 'typescript',
      filePath: '/tmp/file.ts',
    },
    {
      endpoint: 'https://api.openai.com/v1/responses',
      model: 'codex-test',
      instructions: 'Return only code',
    },
  ));

  const { promptPayload } = parsePromptPayload(requestBody);
  assert.equal(promptPayload.task, 'complete_split_call');
});

test('CodexProvider annotates partial member tasks in prompt payload', () => {
  const requestBody = JSON.stringify(buildCodexRequestBodyObject(
    {
      prefix: [
        'static string CaseSuffixOnly(string value)',
        '{',
        '    return value.Trim().ToLowe',
      ].join('\n'),
      suffix: '\n}\n',
      linePrefix: '    return value.Trim().ToLowe',
      lineSuffix: '',
      languageId: 'csharp',
      filePath: '/tmp/file.cs',
    },
    {
      endpoint: 'https://api.openai.com/v1/responses',
      model: 'codex-test',
      instructions: 'Return only code',
    },
  ));

  const { promptPayload } = parsePromptPayload(requestBody);
  assert.equal(promptPayload.task, 'continue_partial_member');
});

test('CodexProvider omits API-only fields for chatgpt backend endpoint', async () => {
  const httpClient = new FakeHttpClient([
    { status: 200, chunks: ['data: [DONE]\n\n'] },
  ]);

  const provider = new CodexProvider({
    endpoint: 'https://chatgpt.com/backend-api/codex/responses',
    model: 'codex-test',
    tokenManager: { getAccessToken: async () => 'token' },
    httpClient,
    maxOutputTokens: 128,
    serviceTier: 'priority',
    promptCacheKey: 'cache-key',
    promptCacheRetention: '24h',
  });

  for await (const _chunk of provider.streamCompletion(
    {
      prefix: 'x = ',
      suffix: '\nprint(x)',
      languageId: 'python',
      filePath: '/tmp/file.py',
    },
    new AbortController().signal,
  )) {
    // consume
  }

  const { body, promptPayload } = parsePromptPayload(httpClient.requests[0].body);
  assert.equal('max_output_tokens' in body, false);
  assert.equal('service_tier' in body, false);
  assert.equal('prompt_cache_key' in body, false);
  assert.equal('prompt_cache_retention' in body, false);
  assert.deepEqual(body.reasoning, { effort: 'none' });
  assert.deepEqual(body.text, { verbosity: 'low' });
  assert.equal('summary' in body, false);
  assert.equal(promptPayload.file_path, '/tmp/file.py');
});

test('buildCodexRequestBodyObject mirrors provider request-body defaults', () => {
  const body = buildCodexRequestBodyObject(
    {
      prefix: 'return profi',
      suffix: '',
      linePrefix: 'return profi',
      lineSuffix: '',
      languageId: 'python',
      filePath: '/tmp/file.py',
      promptCacheKey: 'cache-key:fast',
      promptCacheRetention: '24h',
      serviceTier: 'priority',
      maxOutputTokens: 64,
    },
    {
      endpoint: 'https://api.openai.com/v1/responses',
      model: 'codex-test',
      instructions: 'Return only code',
      maxOutputTokens: 128,
      serviceTier: 'default',
      promptCacheKey: 'cache-key',
      promptCacheRetention: '1h',
    },
  );

  assert.equal(body.model, 'codex-test');
  assert.deepEqual(body.reasoning, { effort: 'none' });
  assert.deepEqual(body.text, { verbosity: 'low' });
  assert.equal('summary' in body, false);
  assert.equal(body.max_output_tokens, 64);
  assert.equal(body.service_tier, 'priority');
  assert.equal(body.prompt_cache_key, 'cache-key:fast');
  assert.equal(body.prompt_cache_retention, '24h');
  assert.equal(Array.isArray(body.input), true);
});

test('buildCodexRequestBodyObject includes selection only when non-empty and supports low reasoning effort', () => {
  const withSelection = buildCodexRequestBodyObject(
    {
      prefix: 'return profile',
      suffix: '\n',
      linePrefix: 'return profile',
      lineSuffix: '',
      selection: 'profile',
      languageId: 'python',
      filePath: '/tmp/file.py',
      reasoningEffort: 'low',
    },
    {
      endpoint: 'https://api.openai.com/v1/responses',
      model: 'codex-test',
      instructions: 'Return only code',
    },
  );
  const withoutSelection = buildCodexRequestBodyObject(
    {
      prefix: 'return profile',
      suffix: '\n',
      linePrefix: 'return profile',
      lineSuffix: '',
      selection: '',
      languageId: 'python',
      filePath: '/tmp/file.py',
    },
    {
      endpoint: 'https://api.openai.com/v1/responses',
      model: 'codex-test',
      instructions: 'Return only code',
    },
  );

  const withSelectionParsed = parsePromptPayload(JSON.stringify(withSelection));
  const withoutSelectionParsed = parsePromptPayload(JSON.stringify(withoutSelection));

  assert.deepEqual(withSelectionParsed.body.reasoning, { effort: 'low' });
  assert.equal(withSelectionParsed.promptPayload.file_path, '/tmp/file.py');
  assert.equal(withSelectionParsed.promptPayload.selection, 'profile');
  assert.equal(withoutSelectionParsed.promptPayload.file_path, '/tmp/file.py');
  assert.equal('selection' in withoutSelectionParsed.promptPayload, false);
});

// Stable autocomplete fixture so bulk CLI coverage includes a real repo test file.
function codexProviderAutocompleteFixture(promptPayload) {
  return promptPayload.cursor_context[''];
}
