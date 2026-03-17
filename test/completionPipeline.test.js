require('./helpers/registerVscode.js');

const test = require('node:test');
const assert = require('node:assert/strict');

const { CompletionPipeline } = require('../out/completion/completionPipeline.js');
const {
  getCodexLogLevel,
  setCodexLogLevel,
} = require('../out/logging/codexLogger.js');

function buildLatencyBudget() {
  return {
    maxLatencyMs: 1000,
    firstChunkMaxLatencyMs: 1000,
    fastStageMaxLatencyMs: 1000,
  };
}

function buildRequests() {
  return {
    fastRequest: {
      prefix: 'fast-prefix',
      suffix: 'fast-suffix',
      languageId: 'python',
      filePath: '/tmp/test.py',
      context: undefined,
      priority: 'high',
    },
    fullRequestFactory: async () => ({
      prefix: 'full-prefix',
      suffix: 'full-suffix',
      languageId: 'python',
      filePath: '/tmp/test.py',
      context: 'full-context',
      priority: 'high',
    }),
  };
}

test('CompletionPipeline does not reuse cached suggestion for unchanged context hash', async () => {
  let callCount = 0;
  const provider = {
    async *streamCompletion() {
      callCount += 1;
      yield { text: 'network', done: false };
      yield { text: '', done: true };
    },
  };

  const pipeline = new CompletionPipeline(provider);
  pipeline.recordAcceptedSuggestion('/tmp/file.py', 'hash-1', 'cached');

  const result = await pipeline.getSuggestion({
    editorKey: '/tmp/file.py',
    contextHash: 'hash-1',
    ...buildRequests(),
    latencyBudget: buildLatencyBudget(),
    skipFastStage: false,
    signal: new AbortController().signal,
  });

  assert.equal(result.suggestion, 'network');
  assert.equal(result.completedContextHashHit, false);
  assert.equal(callCount, 1);
});

test('CompletionPipeline does not skip provider call after completed empty result for same hash', async () => {
  let callCount = 0;
  const provider = {
    async *streamCompletion() {
      callCount += 1;
      yield { text: 'network', done: false };
      yield { text: '', done: true };
    },
  };

  const pipeline = new CompletionPipeline(provider);
  pipeline.recordAcceptedSuggestion('/tmp/file.py', 'hash-2', '   ');

  const result = await pipeline.getSuggestion({
    editorKey: '/tmp/file.py',
    contextHash: 'hash-2',
    ...buildRequests(),
    latencyBudget: buildLatencyBudget(),
    skipFastStage: false,
    signal: new AbortController().signal,
  });

  assert.equal(result.suggestion, 'network');
  assert.equal(result.completedContextHashHit, false);
  assert.equal(callCount, 1);
});

test('CompletionPipeline falls back to full-context request when fast-stage is empty', async () => {
  const seenContexts = [];
  const provider = {
    async *streamCompletion(request) {
      seenContexts.push(request.context);
      if (request.context === undefined) {
        yield { text: '', done: true };
        return;
      }
      yield { text: 'from-full', done: false };
      yield { text: '', done: true };
    },
  };

  const pipeline = new CompletionPipeline(provider);
  const result = await pipeline.getSuggestion({
    editorKey: '/tmp/file.py',
    contextHash: 'hash-3',
    ...buildRequests(),
    latencyBudget: buildLatencyBudget(),
    skipFastStage: false,
    signal: new AbortController().signal,
  });

  assert.equal(result.suggestion, 'from-full');
  assert.deepEqual(seenContexts, [undefined, 'full-context']);
});

test('CompletionPipeline emits stage telemetry for fast hit', async () => {
  const events = [];
  const provider = {
    async *streamCompletion(request) {
      if (request.context === undefined) {
        yield { text: 'fast-hit', done: false };
        yield { text: '', done: true };
        return;
      }
      yield { text: 'from-full', done: false };
      yield { text: '', done: true };
    },
  };

  const pipeline = new CompletionPipeline(
    provider,
    undefined,
    (event) => events.push(event),
  );
  const result = await pipeline.getSuggestion({
    editorKey: '/tmp/file.py',
    contextHash: 'hash-stage-fast-hit',
    ...buildRequests(),
    latencyBudget: buildLatencyBudget(),
    skipFastStage: false,
    signal: new AbortController().signal,
  });

  assert.equal(result.suggestion, 'fast-hit');
  assert.equal(events.length, 1);
  assert.equal(events[0].stage, 'fast');
  assert.equal(events[0].outcome, 'hit');
  assert.ok(events[0].latencyMs >= 0);
});

test('CompletionPipeline emits stage telemetry for fast fallback to full', async () => {
  const events = [];
  const provider = {
    async *streamCompletion(request) {
      if (request.context === undefined) {
        yield { text: '', done: true };
        return;
      }
      yield { text: 'from-full', done: false };
      yield { text: '', done: true };
    },
  };

  const pipeline = new CompletionPipeline(
    provider,
    undefined,
    (event) => events.push(event),
  );
  const result = await pipeline.getSuggestion({
    editorKey: '/tmp/file.py',
    contextHash: 'hash-stage-fallback',
    ...buildRequests(),
    latencyBudget: buildLatencyBudget(),
    skipFastStage: false,
    signal: new AbortController().signal,
  });

  assert.equal(result.suggestion, 'from-full');
  assert.equal(events.length, 2);
  assert.equal(events[0].stage, 'fast');
  assert.equal(events[0].outcome, 'empty');
  assert.equal(events[1].stage, 'full');
  assert.equal(events[1].outcome, 'completed');
  assert.equal(events[1].reason, 'fallback_after_empty');
});

test('CompletionPipeline prewarms full request while fast-stage runs', async () => {
  let fullFactoryCalls = 0;
  const provider = {
    async *streamCompletion(request) {
      if (request.context === undefined) {
        yield { text: 'fast-hit', done: false };
        yield { text: '', done: true };
        return;
      }
      yield { text: 'from-full', done: false };
      yield { text: '', done: true };
    },
  };

  const pipeline = new CompletionPipeline(provider);
  const result = await pipeline.getSuggestion({
    editorKey: '/tmp/file.py',
    contextHash: 'hash-prewarm',
    fastRequest: buildRequests().fastRequest,
    fullRequestFactory: async () => {
      fullFactoryCalls += 1;
      return buildRequests().fullRequestFactory();
    },
    latencyBudget: buildLatencyBudget(),
    skipFastStage: false,
    signal: new AbortController().signal,
  });

  assert.equal(result.suggestion, 'fast-hit');
  assert.equal(fullFactoryCalls, 1);
});

test('CompletionPipeline keeps fast-stage result even if prewarmed full request fails', async () => {
  const provider = {
    async *streamCompletion(request) {
      if (request.context === undefined) {
        yield { text: 'fast-hit', done: false };
        yield { text: '', done: true };
        return;
      }
      yield { text: 'from-full', done: false };
      yield { text: '', done: true };
    },
  };

  const pipeline = new CompletionPipeline(provider);
  const result = await pipeline.getSuggestion({
    editorKey: '/tmp/file.py',
    contextHash: 'hash-prewarm-failure',
    fastRequest: buildRequests().fastRequest,
    fullRequestFactory: async () => {
      throw new Error('full request build failed');
    },
    latencyBudget: buildLatencyBudget(),
    skipFastStage: false,
    signal: new AbortController().signal,
  });

  assert.equal(result.suggestion, 'fast-hit');
});

test('CompletionPipeline skips fast-stage when configured', async () => {
  const seenContexts = [];
  const provider = {
    async *streamCompletion(request) {
      seenContexts.push(request.context);
      yield { text: 'from-full-only', done: false };
      yield { text: '', done: true };
    },
  };

  const pipeline = new CompletionPipeline(provider);
  const result = await pipeline.getSuggestion({
    editorKey: '/tmp/file.py',
    contextHash: 'hash-4',
    ...buildRequests(),
    latencyBudget: buildLatencyBudget(),
    skipFastStage: true,
    signal: new AbortController().signal,
  });

  assert.equal(result.suggestion, 'from-full-only');
  assert.deepEqual(seenContexts, ['full-context']);
});



test('CompletionPipeline retries blank non-structural code lines and keeps a suspicious non-empty result', async () => {
  const seenRequests = [];
  const provider = {
    async *streamCompletion(request) {
      seenRequests.push(request);
      if (seenRequests.length === 1) {
        yield { text: '', done: true };
        return;
      }
      yield { text: 'print(profile)', done: false };
      yield { text: '', done: true };
    },
  };

  const pipeline = new CompletionPipeline(provider);
  const result = await pipeline.getSuggestion({
    editorKey: '/tmp/file.py',
    contextHash: 'hash-hotkey-blank-retry',
    fastRequest: {
      prefix: [
        'def render_profile(profile: str) -> None:',
        '    ',
      ].join('\n'),
      suffix: '    print(profile)',
      linePrefix: '    ',
      lineSuffix: '',
      languageId: 'python',
      filePath: '/tmp/test.py',
      context: undefined,
      instructions: 'Return only inserted text.',
      promptCacheKey: 'k:blank-retry',
      priority: 'high',
    },
    fullRequestFactory: async () => ({
      prefix: [
        'def render_profile(profile: str) -> None:',
        '    ',
      ].join('\n'),
      suffix: '    print(profile)',
      linePrefix: '    ',
      lineSuffix: '',
      languageId: 'python',
      filePath: '/tmp/test.py',
      context: undefined,
      instructions: 'Return only inserted text.',
      promptCacheKey: 'k:blank-retry',
      priority: 'high',
    }),
    latencyBudget: buildLatencyBudget(),
    skipFastStage: true,
    hotkeySemanticRetry: {
      enabled: true,
      retryOnEmpty: true,
      maxLatencyMs: 120,
      firstChunkMaxLatencyMs: 80,
    },
    signal: new AbortController().signal,
  });

  assert.equal(result.suggestion, 'print(profile)');
  assert.equal(seenRequests.length, 3);
  assert.equal(seenRequests[0].reasoningEffort, undefined);
  assert.equal(seenRequests[1].reasoningEffort, 'low');
  assert.equal(seenRequests[2].reasoningEffort, 'low');
});

test('CompletionPipeline keeps first empty result when hotkey blank retry is disabled', async () => {
  let callCount = 0;
  const provider = {
    async *streamCompletion() {
      callCount += 1;
      yield { text: '', done: true };
    },
  };

  const pipeline = new CompletionPipeline(provider);
  const result = await pipeline.getSuggestion({
    editorKey: '/tmp/file.py',
    contextHash: 'hash-hotkey-blank-retry-disabled',
    ...buildRequests(),
    latencyBudget: buildLatencyBudget(),
    skipFastStage: true,
    hotkeySemanticRetry: {
      enabled: true,
      retryOnEmpty: false,
      maxLatencyMs: 120,
      firstChunkMaxLatencyMs: 80,
    },
    signal: new AbortController().signal,
  });

  assert.equal(result.suggestion, '');
  assert.equal(callCount, 1);
});

test('CompletionPipeline performs one hotkey semantic retry with tiny budget', async () => {
  const seenRequests = [];
  const provider = {
    async *streamCompletion(request) {
      seenRequests.push(request);
      if (seenRequests.length === 1) {
        yield { text: '"Mina")', done: false };
      } else {
        yield { text: 'name)', done: false };
      }
      yield { text: '', done: true };
    },
  };

  const pipeline = new CompletionPipeline(provider);
  const result = await pipeline.getSuggestion({
    editorKey: '/tmp/file.py',
    contextHash: 'hash-hotkey-retry',
    fastRequest: {
      ...buildRequests().fastRequest,
      prefix: 'message = greet(',
      suffix: '',
    },
    fullRequestFactory: async () => ({
      ...await buildRequests().fullRequestFactory(),
      prefix: 'normalized = format_name(user)\nmessage = greet(',
      suffix: '',
      instructions: 'Return only inserted text.',
      promptCacheKey: 'k:full',
    }),
    latencyBudget: buildLatencyBudget(),
    skipFastStage: true,
    hotkeySemanticRetry: {
      enabled: true,
      retryOnEmpty: true,
      maxLatencyMs: 120,
      firstChunkMaxLatencyMs: 80,
    },
    signal: new AbortController().signal,
  });

  assert.equal(result.suggestion, 'name)');
  assert.equal(seenRequests.length, 2);
  assert.equal(seenRequests[0].reasoningEffort, undefined);
  assert.equal(seenRequests[1].reasoningEffort, 'low');
  assert.match(seenRequests[1].instructions ?? '', /Hotkey semantic retry requirements:/);
  assert.match(seenRequests[1].instructions ?? '', /Previous attempt: .*Mina/);
  assert.equal(seenRequests[1].promptCacheKey, 'k:full:sem1');
});

test('CompletionPipeline duplicate retry adds forbidden duplicate guidance', async () => {
  const seenRequests = [];
  const provider = {
    async *streamCompletion(request) {
      seenRequests.push(request);
      yield { text: 'message = buildSummary(amounts);', done: false };
      yield { text: '', done: true };
    },
  };

  const pipeline = new CompletionPipeline(provider);
  const result = await pipeline.runHotkeyDuplicateRetry({
    request: {
      prefix: [
        'static String runArgumentsCase(List<Double> amounts) {',
        '    ',
        '    return summary;',
      ].join('\n'),
      suffix: '',
      languageId: 'java',
      filePath: '/tmp/test.java',
      context: 'full-context',
      instructions: 'Return only inserted text.',
      promptCacheKey: 'k:duplicate',
      priority: 'high',
      interactionMode: 'hotkey',
    },
    previousAttempt: 'return summary;',
    forbiddenDuplicate: 'return summary;',
    maxLatencyMs: 120,
    firstChunkMaxLatencyMs: 80,
    signal: new AbortController().signal,
  });

  assert.equal(result.suggestion, 'message = buildSummary(amounts);');
  assert.equal(seenRequests.length, 1);
  assert.equal(seenRequests[0].reasoningEffort, 'low');
  assert.equal(seenRequests[0].promptCacheKey, 'k:duplicate:sem1');
  assert.match(
    seenRequests[0].instructions ?? '',
    /Do not return the exact duplicate later-suffix line: "return summary;"/,
  );
});

test('CompletionPipeline keeps return value blank-line statements without semantic retry', async () => {
  let callCount = 0;
  const provider = {
    async *streamCompletion() {
      callCount += 1;
      yield { text: 'return message;', done: false };
      yield { text: '', done: true };
    },
  };

  const pipeline = new CompletionPipeline(provider);
  const result = await pipeline.getSuggestion({
    editorKey: '/tmp/file.js',
    contextHash: 'hash-hotkey-return-value-blank-line',
    fastRequest: {
      prefix: [
        'function runDemo() {',
        '  const normalized = titleCase("sAm lee");',
        '  const message = welcome(normalized);',
        '  ',
      ].join('\n'),
      suffix: '  console.log(message);\n}\n',
      linePrefix: '  ',
      lineSuffix: '',
      languageId: 'javascript',
      filePath: '/tmp/test.js',
      context: undefined,
      instructions: 'Return only inserted text.',
      promptCacheKey: 'k:return-message',
      priority: 'high',
      interactionMode: 'hotkey',
    },
    fullRequestFactory: async () => ({
      prefix: [
        'function runDemo() {',
        '  const normalized = titleCase("sAm lee");',
        '  const message = welcome(normalized);',
        '  ',
      ].join('\n'),
      suffix: '  console.log(message);\n}\n',
      linePrefix: '  ',
      lineSuffix: '',
      languageId: 'javascript',
      filePath: '/tmp/test.js',
      context: undefined,
      instructions: 'Return only inserted text.',
      promptCacheKey: 'k:return-message',
      priority: 'high',
      interactionMode: 'hotkey',
    }),
    latencyBudget: buildLatencyBudget(),
    skipFastStage: true,
    hotkeySemanticRetry: {
      enabled: true,
      retryOnEmpty: true,
      maxLatencyMs: 120,
      firstChunkMaxLatencyMs: 80,
    },
    signal: new AbortController().signal,
  });

  assert.equal(result.suggestion, 'return message;');
  assert.equal(callCount, 1);
});

test('CompletionPipeline blacklists exact nearby blank-line duplicates during semantic retry', async () => {
  const seenRequests = [];
  const provider = {
    async *streamCompletion(request) {
      seenRequests.push(request);
      if (seenRequests.length === 1) {
        yield { text: 'status = format_status(user, True)', done: false };
        yield { text: '', done: true };
        return;
      }
      yield { text: 'status = status.upper()', done: false };
      yield { text: '', done: true };
    },
  };

  const pipeline = new CompletionPipeline(provider);
  const result = await pipeline.getSuggestion({
    editorKey: '/tmp/file.py',
    contextHash: 'hash-hotkey-nearby-duplicate-blacklist',
    fastRequest: {
      prefix: [
        'def case_call_completion(user: str) -> str:',
        '    status = format_status(user, True)',
        '    ',
      ].join('\n'),
      suffix: '    return status\n',
      linePrefix: '    ',
      lineSuffix: '',
      languageId: 'python',
      filePath: '/tmp/test.py',
      context: undefined,
      instructions: 'Return only inserted text.',
      promptCacheKey: 'k:blank-duplicate',
      priority: 'high',
      interactionMode: 'hotkey',
    },
    fullRequestFactory: async () => ({
      prefix: [
        'def case_call_completion(user: str) -> str:',
        '    status = format_status(user, True)',
        '    ',
      ].join('\n'),
      suffix: '    return status\n',
      linePrefix: '    ',
      lineSuffix: '',
      languageId: 'python',
      filePath: '/tmp/test.py',
      context: undefined,
      instructions: 'Return only inserted text.',
      promptCacheKey: 'k:blank-duplicate',
      priority: 'high',
      interactionMode: 'hotkey',
    }),
    latencyBudget: buildLatencyBudget(),
    skipFastStage: true,
    hotkeySemanticRetry: {
      enabled: true,
      retryOnEmpty: true,
      maxLatencyMs: 120,
      firstChunkMaxLatencyMs: 80,
    },
    signal: new AbortController().signal,
  });

  assert.equal(result.suggestion, 'status = status.upper()');
  assert.equal(seenRequests.length, 2);
  assert.match(
    seenRequests[1].instructions ?? '',
    /Do not return the exact duplicate later-suffix line: "status = format_status\(user, True\)"/,
  );
});

test('CompletionPipeline blacklists nearby blank-line duplicates when only spacing differs', async () => {
  const seenRequests = [];
  const provider = {
    async *streamCompletion(request) {
      seenRequests.push(request);
      if (seenRequests.length === 1) {
        yield { text: 'status  =  format_status(user, True)', done: false };
        yield { text: '', done: true };
        return;
      }
      yield { text: 'status = status.upper()', done: false };
      yield { text: '', done: true };
    },
  };

  const pipeline = new CompletionPipeline(provider);
  const result = await pipeline.getSuggestion({
    editorKey: '/tmp/file.py',
    contextHash: 'hash-hotkey-nearby-duplicate-spacing-blacklist',
    fastRequest: {
      prefix: [
        'def case_call_completion(user: str) -> str:',
        '    status = format_status(user, True)',
        '    ',
      ].join('\n'),
      suffix: '    return status\n',
      linePrefix: '    ',
      lineSuffix: '',
      languageId: 'python',
      filePath: '/tmp/test.py',
      context: undefined,
      instructions: 'Return only inserted text.',
      promptCacheKey: 'k:blank-duplicate-spacing',
      priority: 'high',
      interactionMode: 'hotkey',
    },
    fullRequestFactory: async () => ({
      prefix: [
        'def case_call_completion(user: str) -> str:',
        '    status = format_status(user, True)',
        '    ',
      ].join('\n'),
      suffix: '    return status\n',
      linePrefix: '    ',
      lineSuffix: '',
      languageId: 'python',
      filePath: '/tmp/test.py',
      context: undefined,
      instructions: 'Return only inserted text.',
      promptCacheKey: 'k:blank-duplicate-spacing',
      priority: 'high',
      interactionMode: 'hotkey',
    }),
    latencyBudget: buildLatencyBudget(),
    skipFastStage: true,
    hotkeySemanticRetry: {
      enabled: true,
      retryOnEmpty: true,
      maxLatencyMs: 120,
      firstChunkMaxLatencyMs: 80,
    },
    signal: new AbortController().signal,
  });

  assert.equal(result.suggestion, 'status = status.upper()');
  assert.equal(seenRequests.length, 2);
  assert.match(
    seenRequests[1].instructions ?? '',
    /Do not return the exact duplicate later-suffix line: "status = format_status\(user, True\)"/,
  );
});

test('CompletionPipeline blacklists nearby blank-line duplicates when tabs differ', async () => {
  const seenRequests = [];
  const provider = {
    async *streamCompletion(request) {
      seenRequests.push(request);
      if (seenRequests.length === 1) {
        yield { text: 'status\t=\tformat_status(user, True)', done: false };
        yield { text: '', done: true };
        return;
      }
      yield { text: 'status = status.upper()', done: false };
      yield { text: '', done: true };
    },
  };

  const pipeline = new CompletionPipeline(provider);
  const result = await pipeline.getSuggestion({
    editorKey: '/tmp/file.py',
    contextHash: 'hash-hotkey-nearby-duplicate-tabs-blacklist',
    fastRequest: {
      prefix: [
        'def case_call_completion(user: str) -> str:',
        '    status = format_status(user, True)',
        '    ',
      ].join('\n'),
      suffix: '    return status\n',
      linePrefix: '    ',
      lineSuffix: '',
      languageId: 'python',
      filePath: '/tmp/test.py',
      context: undefined,
      instructions: 'Return only inserted text.',
      promptCacheKey: 'k:blank-duplicate-tabs',
      priority: 'high',
      interactionMode: 'hotkey',
    },
    fullRequestFactory: async () => ({
      prefix: [
        'def case_call_completion(user: str) -> str:',
        '    status = format_status(user, True)',
        '    ',
      ].join('\n'),
      suffix: '    return status\n',
      linePrefix: '    ',
      lineSuffix: '',
      languageId: 'python',
      filePath: '/tmp/test.py',
      context: undefined,
      instructions: 'Return only inserted text.',
      promptCacheKey: 'k:blank-duplicate-tabs',
      priority: 'high',
      interactionMode: 'hotkey',
    }),
    latencyBudget: buildLatencyBudget(),
    skipFastStage: true,
    hotkeySemanticRetry: {
      enabled: true,
      retryOnEmpty: true,
      maxLatencyMs: 120,
      firstChunkMaxLatencyMs: 80,
    },
    signal: new AbortController().signal,
  });

  assert.equal(result.suggestion, 'status = status.upper()');
  assert.equal(seenRequests.length, 2);
  assert.match(
    seenRequests[1].instructions ?? '',
    /Do not return the exact duplicate later-suffix line: "status = format_status\(user, True\)"/,
  );
});

test('CompletionPipeline drops suspicious duplicate blank-line suggestion when semantic retry times out', async () => {
  let callCount = 0;
  const provider = {
    async *streamCompletion() {
      callCount += 1;
      if (callCount === 1) {
        yield { text: 'var message = Welcome(normalized);', done: false };
        yield { text: '', done: true };
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 120));
      yield { text: '', done: true };
    },
  };

  const pipeline = new CompletionPipeline(provider);
  const result = await pipeline.getSuggestion({
    editorKey: '/tmp/simple_autocomplete.cs',
    contextHash: 'hash-hotkey-duplicate-timeout-drop',
    fastRequest: {
      prefix: [
        'static void RunDemo()',
        '{',
        '    var normalized = "Mina";',
        '    var message = Welcome(normalized);',
        '    ',
      ].join('\n'),
      suffix: '    Console.WriteLine(message);\n}\n',
      linePrefix: '    ',
      lineSuffix: '',
      languageId: 'csharp',
      filePath: '/tmp/simple_autocomplete.cs',
      context: undefined,
      instructions: 'Return only inserted text.',
      promptCacheKey: 'k:blank-duplicate-timeout',
      priority: 'high',
      interactionMode: 'hotkey',
    },
    fullRequestFactory: async () => ({
      prefix: [
        'static void RunDemo()',
        '{',
        '    var normalized = "Mina";',
        '    var message = Welcome(normalized);',
        '    ',
      ].join('\n'),
      suffix: '    Console.WriteLine(message);\n}\n',
      linePrefix: '    ',
      lineSuffix: '',
      languageId: 'csharp',
      filePath: '/tmp/simple_autocomplete.cs',
      context: undefined,
      instructions: 'Return only inserted text.',
      promptCacheKey: 'k:blank-duplicate-timeout',
      priority: 'high',
      interactionMode: 'hotkey',
    }),
    latencyBudget: buildLatencyBudget(),
    skipFastStage: true,
    hotkeySemanticRetry: {
      enabled: true,
      retryOnEmpty: true,
      maxLatencyMs: 120,
      firstChunkMaxLatencyMs: 80,
    },
    signal: new AbortController().signal,
  });

  assert.equal(result.suggestion, '');
  assert.equal(result.timedOutBeforeFirstChunk, false);
  assert.equal(result.timedOut, false);
  assert.equal(callCount, 2);
});

test('CompletionPipeline floors full-stage first-chunk budget after semantic retry timeout', async () => {
  let callCount = 0;
  const provider = {
    async *streamCompletion() {
      callCount += 1;
      if (callCount === 1) {
        yield { text: 'pass', done: false };
        yield { text: '', done: true };
        return;
      }
      if (callCount === 2) {
        await new Promise((resolve) => setTimeout(resolve, 120));
        yield { text: '', done: true };
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      yield { text: 'normalized)', done: false };
      yield { text: '', done: true };
    },
  };

  const pipeline = new CompletionPipeline(provider);
  const result = await pipeline.getSuggestion({
    editorKey: '/tmp/file.py',
    contextHash: 'hash-hotkey-full-stage-floor',
    fastRequest: {
      prefix: 'def greet_user(name: str) -> str:\n    ',
      suffix: '    return name\n',
      linePrefix: '    ',
      lineSuffix: '',
      languageId: 'python',
      filePath: '/tmp/test.py',
      context: undefined,
      instructions: 'Return only inserted text.',
      promptCacheKey: 'k:floor',
      priority: 'high',
      interactionMode: 'hotkey',
    },
    fullRequestFactory: async () => ({
      prefix: 'def greet_user(name: str) -> str:\n    ',
      suffix: '    return name\n',
      linePrefix: '    ',
      lineSuffix: '',
      languageId: 'python',
      filePath: '/tmp/test.py',
      context: 'full-context',
      instructions: 'Return only inserted text.',
      promptCacheKey: 'k:floor',
      priority: 'high',
      interactionMode: 'hotkey',
    }),
    latencyBudget: {
      maxLatencyMs: 500,
      firstChunkMaxLatencyMs: 80,
      fastStageMaxLatencyMs: 100,
    },
    skipFastStage: false,
    hotkeySemanticRetry: {
      enabled: true,
      retryOnEmpty: false,
      maxLatencyMs: 120,
      firstChunkMaxLatencyMs: 80,
    },
    signal: new AbortController().signal,
  });

  assert.equal(result.suggestion, 'normalized)');
  assert.equal(callCount, 4);
});

test('CompletionPipeline hotkey-retries when a string literal loses its opening quote', async () => {
  let callCount = 0;
  const provider = {
    async *streamCompletion() {
      callCount += 1;
      if (callCount === 1) {
        yield { text: 'P1");', done: false };
      } else {
        yield { text: '"P1");', done: false };
      }
      yield { text: '', done: true };
    },
  };

  const pipeline = new CompletionPipeline(provider);
  const result = await pipeline.getSuggestion({
    editorKey: '/tmp/file.ts',
    contextHash: 'hash-hotkey-missing-open-quote',
    fastRequest: {
      prefix: [
        'const priorities = ["P0", "P1", "P2"];',
        'const openPointsByPriority = (priority) => priority.length;',
        'return openPointsByPriority(',
      ].join('\n'),
      suffix: '',
      languageId: 'typescript',
      filePath: '/tmp/test.ts',
      context: undefined,
      instructions: 'Return only inserted text.',
      promptCacheKey: 'k:quote',
      priority: 'high',
    },
    fullRequestFactory: async () => ({
      prefix: [
        'const priorities = ["P0", "P1", "P2"];',
        'const openPointsByPriority = (priority) => priority.length;',
        'return openPointsByPriority(',
      ].join('\n'),
      suffix: '',
      languageId: 'typescript',
      filePath: '/tmp/test.ts',
      context: undefined,
      instructions: 'Return only inserted text.',
      promptCacheKey: 'k:quote',
      priority: 'high',
    }),
    latencyBudget: buildLatencyBudget(),
    skipFastStage: true,
    hotkeySemanticRetry: {
      enabled: true,
      retryOnEmpty: true,
      maxLatencyMs: 120,
      firstChunkMaxLatencyMs: 80,
    },
    signal: new AbortController().signal,
  });

  assert.equal(result.suggestion, '"P1");');
  assert.equal(callCount, 2);
});

test('CompletionPipeline hotkey-retries over-completed bare return values', async () => {
  let callCount = 0;
  const provider = {
    async *streamCompletion() {
      callCount += 1;
      if (callCount === 1) {
        yield { text: 'first[0]', done: false };
      } else {
        yield { text: 'first', done: false };
      }
      yield { text: '', done: true };
    },
  };

  const pipeline = new CompletionPipeline(provider);
  const result = await pipeline.getSuggestion({
    editorKey: '/tmp/file.py',
    contextHash: 'hash-hotkey-return-retry',
    fastRequest: {
      prefix: [
        'def run_chain_case(metrics: list[int]) -> str:',
        '    first = summarize_metrics(metrics, include_inactive=False, precision=2).split(',
        '    return',
      ].join('\n'),
      suffix: '',
      linePrefix: '    return',
      lineSuffix: '',
      languageId: 'python',
      filePath: '/tmp/test.py',
      context: undefined,
      instructions: 'Return only inserted text.',
      promptCacheKey: 'k:return',
      priority: 'high',
    },
    fullRequestFactory: async () => ({
      prefix: [
        'def run_chain_case(metrics: list[int]) -> str:',
        '    first = summarize_metrics(metrics, include_inactive=False, precision=2).split(',
        '    return',
      ].join('\n'),
      suffix: '',
      linePrefix: '    return',
      lineSuffix: '',
      languageId: 'python',
      filePath: '/tmp/test.py',
      context: undefined,
      instructions: 'Return only inserted text.',
      promptCacheKey: 'k:return',
      priority: 'high',
    }),
    latencyBudget: buildLatencyBudget(),
    skipFastStage: true,
    hotkeySemanticRetry: {
      enabled: true,
      retryOnEmpty: true,
      maxLatencyMs: 120,
      firstChunkMaxLatencyMs: 80,
    },
    signal: new AbortController().signal,
  });

  assert.equal(result.suggestion, 'first');
  assert.equal(callCount, 2);
});

test('CompletionPipeline keeps suspicious non-empty results after pass placeholders retry into copied later lines', async () => {
  let callCount = 0;
  const provider = {
    async *streamCompletion() {
      callCount += 1;
      if (callCount === 1) {
        yield { text: 'pass', done: false };
      } else {
        yield {
          text: 'return Query(table=table, filters=filters, limit=limit, order_by=order_by)',
          done: false,
        };
      }
      yield { text: '', done: true };
    },
  };

  const pipeline = new CompletionPipeline(provider);
  const result = await pipeline.getSuggestion({
    editorKey: '/tmp/file.py',
    contextHash: 'hash-hotkey-pass-retry',
    fastRequest: {
      prefix: [
        'def build_query(table: str, filters: dict[str, Any], limit: int, order_by: str) -> Query:',
        '    ',
      ].join('\n'),
      suffix: [
        '    #      ',
        '    return Query(table=table, filters=filters, limit=limit, order_by=order_by)',
      ].join('\n'),
      linePrefix: '    ',
      lineSuffix: '',
      languageId: 'python',
      filePath: '/tmp/test.py',
      context: undefined,
      instructions: 'Return only inserted text.',
      promptCacheKey: 'k:pass',
      priority: 'high',
    },
    fullRequestFactory: async () => ({
      prefix: [
        'def build_query(table: str, filters: dict[str, Any], limit: int, order_by: str) -> Query:',
        '    ',
      ].join('\n'),
      suffix: [
        '    #      ',
        '    return Query(table=table, filters=filters, limit=limit, order_by=order_by)',
      ].join('\n'),
      linePrefix: '    ',
      lineSuffix: '',
      languageId: 'python',
      filePath: '/tmp/test.py',
      context: undefined,
      instructions: 'Return only inserted text.',
      promptCacheKey: 'k:pass',
      priority: 'high',
    }),
    latencyBudget: buildLatencyBudget(),
    skipFastStage: true,
    hotkeySemanticRetry: {
      enabled: true,
      retryOnEmpty: true,
      maxLatencyMs: 120,
      firstChunkMaxLatencyMs: 80,
    },
    signal: new AbortController().signal,
  });

  assert.equal(result.suggestion, 'return Query(table=table, filters=filters, limit=limit, order_by=order_by)');
  assert.equal(callCount, 2);
});

test('CompletionPipeline keeps suspicious nearby assignments after fast-stage pass placeholder retry', async () => {
  let callCount = 0;
  const provider = {
    async *streamCompletion() {
      callCount += 1;
      if (callCount === 1) {
        yield { text: 'pass', done: false };
      } else {
        yield { text: 'self.user_id = user_id', done: false };
      }
      yield { text: '', done: true };
    },
  };

  const pipeline = new CompletionPipeline(provider);
  const result = await pipeline.getSuggestion({
    editorKey: '/tmp/file.py',
    contextHash: 'hash-hotkey-fast-pass-retry',
    fastRequest: {
      prefix: [
        'class UserProfile:',
        '    def __init__(self, user_id: int, user_name: str):',
        '        ',
      ].join('\n'),
      suffix: [
        '        self.user_id = user_id',
        '        self.user_name = user_name',
        '        pass',
      ].join('\n'),
      linePrefix: '        ',
      lineSuffix: '',
      languageId: 'python',
      filePath: '/tmp/test.py',
      context: undefined,
      instructions: 'Return only inserted text.',
      promptCacheKey: 'k:fast-pass',
      priority: 'high',
      interactionMode: 'hotkey',
    },
    fullRequestFactory: async () => ({
      prefix: [
        'class UserProfile:',
        '    def __init__(self, user_id: int, user_name: str):',
        '        ',
      ].join('\n'),
      suffix: [
        '        self.user_id = user_id',
        '        self.user_name = user_name',
        '        pass',
      ].join('\n'),
      linePrefix: '        ',
      lineSuffix: '',
      languageId: 'python',
      filePath: '/tmp/test.py',
      context: undefined,
      instructions: 'Return only inserted text.',
      promptCacheKey: 'k:fast-pass',
      priority: 'high',
      interactionMode: 'hotkey',
    }),
    latencyBudget: buildLatencyBudget(),
    skipFastStage: false,
    hotkeySemanticRetry: {
      enabled: true,
      retryOnEmpty: true,
      maxLatencyMs: 120,
      firstChunkMaxLatencyMs: 80,
    },
    signal: new AbortController().signal,
  });

  assert.equal(result.suggestion, 'self.user_id = user_id');
  assert.equal(callCount, 2);
});

test('CompletionPipeline keeps suspicious copied return expressions after pass placeholder retry', async () => {
  let callCount = 0;
  const provider = {
    async *streamCompletion() {
      callCount += 1;
      if (callCount === 1) {
        yield { text: 'pass', done: false };
      } else {
        yield { text: 'return f"{name}:{status}"', done: false };
      }
      yield { text: '', done: true };
    },
  };

  const pipeline = new CompletionPipeline(provider);
  const result = await pipeline.getSuggestion({
    editorKey: '/tmp/file.py',
    contextHash: 'hash-hotkey-pass-retry-return-expression',
    fastRequest: {
      prefix: [
        'def format_status(name: str, status: str) -> str:',
        '    ',
      ].join('\n'),
      suffix: '    return f"{name}:{status}"',
      linePrefix: '    ',
      lineSuffix: '',
      languageId: 'python',
      filePath: '/tmp/test.py',
      context: undefined,
      instructions: 'Return only inserted text.',
      promptCacheKey: 'k:pass-return-expression',
      priority: 'high',
    },
    fullRequestFactory: async () => ({
      prefix: [
        'def format_status(name: str, status: str) -> str:',
        '    ',
      ].join('\n'),
      suffix: '    return f"{name}:{status}"',
      linePrefix: '    ',
      lineSuffix: '',
      languageId: 'python',
      filePath: '/tmp/test.py',
      context: undefined,
      instructions: 'Return only inserted text.',
      promptCacheKey: 'k:pass-return-expression',
      priority: 'high',
    }),
    latencyBudget: buildLatencyBudget(),
    skipFastStage: true,
    hotkeySemanticRetry: {
      enabled: true,
      retryOnEmpty: true,
      maxLatencyMs: 120,
      firstChunkMaxLatencyMs: 80,
    },
    signal: new AbortController().signal,
  });

  assert.equal(result.suggestion, 'return f"{name}:{status}"');
  assert.equal(callCount, 2);
});

test('CompletionPipeline retries empty-result spacer lines and keeps the resulting suspicious statement', async () => {
  let callCount = 0;
  const provider = {
    async *streamCompletion() {
      callCount += 1;
      if (callCount === 1) {
        yield { text: '', done: true };
        return;
      }
      if (callCount === 2) {
        yield { text: 'pass', done: false };
      } else {
        yield { text: 'first = next(iter(values), "none")', done: false };
      }
      yield { text: '', done: true };
    },
  };

  const pipeline = new CompletionPipeline(provider);
  const result = await pipeline.getSuggestion({
    editorKey: '/tmp/file.py',
    contextHash: 'hash-hotkey-blank-pass-retry',
    fastRequest: {
      prefix: [
        'def case_suffix_only(values: Iterable[str]) -> str:',
        '    ',
      ].join('\n'),
      suffix: [
        '    first = next(iter(values), "none")',
        '    return first.up',
      ].join('\n'),
      linePrefix: '    ',
      lineSuffix: '',
      languageId: 'python',
      filePath: '/tmp/test.py',
      context: undefined,
      instructions: 'Return only inserted text.',
      promptCacheKey: 'k:blank-pass',
      priority: 'high',
    },
    fullRequestFactory: async () => ({
      prefix: [
        'from typing import Iterable',
        '',
        'def case_suffix_only(values: Iterable[str]) -> str:',
        '    ',
      ].join('\n'),
      suffix: [
        '    first = next(iter(values), "none")',
        '    return first.up',
      ].join('\n'),
      linePrefix: '    ',
      lineSuffix: '',
      languageId: 'python',
      filePath: '/tmp/test.py',
      context: undefined,
      instructions: 'Return only inserted text.',
      promptCacheKey: 'k:blank-pass',
      priority: 'high',
    }),
    latencyBudget: buildLatencyBudget(),
    skipFastStage: true,
    hotkeySemanticRetry: {
      enabled: true,
      retryOnEmpty: true,
      maxLatencyMs: 120,
      firstChunkMaxLatencyMs: 80,
    },
    signal: new AbortController().signal,
  });

  assert.equal(result.suggestion, 'first = next(iter(values), "none")');
  assert.equal(callCount, 3);
});

test('CompletionPipeline falls back to full stage when spacer-line semantic retry drops a fast pass placeholder', async () => {
  let callCount = 0;
  const provider = {
    async *streamCompletion() {
      callCount += 1;
      if (callCount <= 2) {
        yield { text: 'pass', done: false };
      } else {
        yield { text: 'query = build_query("users", filters, 25, order_by="created_at")', done: false };
      }
      yield { text: '', done: true };
    },
  };

  const pipeline = new CompletionPipeline(provider);
  const result = await pipeline.getSuggestion({
    editorKey: '/tmp/file.py',
    contextHash: 'hash-hotkey-pass-full-fallback',
    fastRequest: {
      prefix: [
        'def run_keyword_args_case() -> Query:',
        '    filters = {"active": True, "country": "US"}',
        '    ',
      ].join('\n'),
      suffix: '    return query',
      linePrefix: '    ',
      lineSuffix: '',
      languageId: 'python',
      filePath: '/tmp/test.py',
      context: undefined,
      instructions: 'Return only inserted text.',
      promptCacheKey: 'k:pass-full-fallback',
      priority: 'high',
      interactionMode: 'hotkey',
    },
    fullRequestFactory: async () => ({
      prefix: [
        'def run_keyword_args_case() -> Query:',
        '    filters = {"active": True, "country": "US"}',
        '    ',
      ].join('\n'),
      suffix: '    return query',
      linePrefix: '    ',
      lineSuffix: '',
      languageId: 'python',
      filePath: '/tmp/test.py',
      context: undefined,
      instructions: 'Return only inserted text.',
      promptCacheKey: 'k:pass-full-fallback',
      priority: 'high',
      interactionMode: 'hotkey',
    }),
    latencyBudget: buildLatencyBudget(),
    skipFastStage: false,
    hotkeySemanticRetry: {
      enabled: true,
      retryOnEmpty: true,
      maxLatencyMs: 120,
      firstChunkMaxLatencyMs: 80,
    },
    signal: new AbortController().signal,
  });

  assert.equal(result.suggestion, 'query = build_query("users", filters, 25, order_by="created_at")');
  assert.equal(callCount, 3);
});

test('CompletionPipeline falls back to full stage when semantic retry returns empty after dropping a fast pass placeholder', async () => {
  let callCount = 0;
  const provider = {
    async *streamCompletion() {
      callCount += 1;
      if (callCount === 1) {
        yield { text: 'pass', done: false };
        yield { text: '', done: true };
        return;
      }
      if (callCount === 2) {
        yield { text: '', done: true };
        return;
      }
      yield { text: 'message = build_message(normalized_name)', done: false };
      yield { text: '', done: true };
    },
  };

  const pipeline = new CompletionPipeline(provider);
  const result = await pipeline.getSuggestion({
    editorKey: '/tmp/file.py',
    contextHash: 'hash-hotkey-pass-empty-retry-full-fallback',
    fastRequest: {
      prefix: [
        'def blank_line_demo(user: dict[str, str]) -> str:',
        '    normalized_name = user["name"].strip().title()',
        '    ',
      ].join('\n'),
      suffix: '    return message',
      linePrefix: '    ',
      lineSuffix: '',
      languageId: 'python',
      filePath: '/tmp/test.py',
      context: undefined,
      instructions: 'Return only inserted text.',
      promptCacheKey: 'k:pass-empty-retry-full-fallback',
      priority: 'high',
      interactionMode: 'hotkey',
    },
    fullRequestFactory: async () => ({
      prefix: [
        'def blank_line_demo(user: dict[str, str]) -> str:',
        '    normalized_name = user["name"].strip().title()',
        '    ',
      ].join('\n'),
      suffix: '    return message',
      linePrefix: '    ',
      lineSuffix: '',
      languageId: 'python',
      filePath: '/tmp/test.py',
      context: undefined,
      instructions: 'Return only inserted text.',
      promptCacheKey: 'k:pass-empty-retry-full-fallback',
      priority: 'high',
      interactionMode: 'hotkey',
    }),
    latencyBudget: buildLatencyBudget(),
    skipFastStage: false,
    hotkeySemanticRetry: {
      enabled: true,
      retryOnEmpty: true,
      maxLatencyMs: 120,
      firstChunkMaxLatencyMs: 80,
    },
    signal: new AbortController().signal,
  });

  assert.equal(result.suggestion, 'message = build_message(normalized_name)');
  assert.equal(callCount, 3);
});

test('CompletionPipeline still runs full-stage blank-line retries when fast-stage returned empty on a spacer line', async () => {
  let callCount = 0;
  const provider = {
    async *streamCompletion() {
      callCount += 1;
      if (callCount === 1) {
        yield { text: '', done: true };
        return;
      }

      yield { text: 'pass', done: false };
      yield { text: '', done: true };
    },
  };

  const pipeline = new CompletionPipeline(provider);
  const result = await pipeline.getSuggestion({
    editorKey: '/tmp/file.py',
    contextHash: 'hash-hotkey-full-pass-drop',
    fastRequest: {
      prefix: [
        'def demo_large_context() -> str:',
        '    report = build_report(METRICS)',
        '    print(report)',
        '    ',
      ].join('\n'),
      suffix: '    return report',
      linePrefix: '    ',
      lineSuffix: '',
      languageId: 'python',
      filePath: '/tmp/test.py',
      context: undefined,
      instructions: 'Return only inserted text.',
      promptCacheKey: 'k:full-pass-drop',
      priority: 'high',
      interactionMode: 'hotkey',
    },
    fullRequestFactory: async () => ({
      prefix: [
        'def demo_large_context() -> str:',
        '    report = build_report(METRICS)',
        '    print(report)',
        '    ',
      ].join('\n'),
      suffix: '    return report',
      linePrefix: '    ',
      lineSuffix: '',
      languageId: 'python',
      filePath: '/tmp/test.py',
      context: undefined,
      instructions: 'Return only inserted text.',
      promptCacheKey: 'k:full-pass-drop',
      priority: 'high',
      interactionMode: 'hotkey',
    }),
    latencyBudget: buildLatencyBudget(),
    skipFastStage: false,
    hotkeySemanticRetry: {
      enabled: true,
      retryOnEmpty: true,
      maxLatencyMs: 120,
      firstChunkMaxLatencyMs: 80,
    },
    signal: new AbortController().signal,
  });

  assert.equal(result.suggestion, '');
  assert.equal(callCount, 3);
});

test('CompletionPipeline does not hotkey-retry for punctuation-only completion', async () => {
  let callCount = 0;
  const provider = {
    async *streamCompletion() {
      callCount += 1;
      yield { text: ')', done: false };
      yield { text: '', done: true };
    },
  };

  const pipeline = new CompletionPipeline(provider);
  const result = await pipeline.getSuggestion({
    editorKey: '/tmp/file.py',
    contextHash: 'hash-hotkey-no-retry',
    ...buildRequests(),
    latencyBudget: buildLatencyBudget(),
    skipFastStage: true,
    hotkeySemanticRetry: {
      enabled: true,
      retryOnEmpty: true,
      maxLatencyMs: 120,
      firstChunkMaxLatencyMs: 80,
    },
    signal: new AbortController().signal,
  });

  assert.equal(result.suggestion, ')');
  assert.equal(callCount, 1);
});

test('CompletionPipeline hotkey-retries punctuation-only blank-line placeholders', async () => {
  const seenRequests = [];
  const provider = {
    async *streamCompletion(request) {
      seenRequests.push(request);
      if (seenRequests.length === 1) {
        yield { text: ';', done: false };
        yield { text: '', done: true };
        return;
      }

      yield { text: 'const message = welcome(normalized);', done: false };
      yield { text: '', done: true };
    },
  };

  const pipeline = new CompletionPipeline(provider);
  const result = await pipeline.getSuggestion({
    editorKey: '/tmp/file.js',
    contextHash: 'hash-hotkey-blank-line-punctuation-retry',
    fastRequest: {
      ...buildRequests().fastRequest,
      prefix: [
        'function runDemo() {',
        '  const normalized = titleCase("sAm lee");',
        '  ',
      ].join('\n'),
      suffix: '  console.log(message);\n}\n',
      linePrefix: '  ',
      lineSuffix: '',
      languageId: 'javascript',
      instructions: 'Return only inserted text.',
      promptCacheKey: 'k:blank-line-semicolon',
      interactionMode: 'hotkey',
    },
    fullRequestFactory: async () => ({
      ...await buildRequests().fullRequestFactory(),
      prefix: [
        'function titleCase(input) {',
        '  return input;',
        '}',
        '',
        'function welcome(name) {',
        '  return `Welcome, ${name}!`;',
        '}',
        '',
        'function runDemo() {',
        '  const normalized = titleCase("sAm lee");',
        '  ',
      ].join('\n'),
      suffix: '  console.log(message);\n}\n',
      linePrefix: '  ',
      lineSuffix: '',
      languageId: 'javascript',
      instructions: 'Return only inserted text.',
      promptCacheKey: 'k:blank-line-semicolon',
      interactionMode: 'hotkey',
    }),
    latencyBudget: buildLatencyBudget(),
    skipFastStage: true,
    hotkeySemanticRetry: {
      enabled: true,
      retryOnEmpty: true,
      maxLatencyMs: 120,
      firstChunkMaxLatencyMs: 80,
    },
    signal: new AbortController().signal,
  });

  assert.equal(result.suggestion, 'const message = welcome(normalized);');
  assert.equal(seenRequests.length, 2);
  assert.match(seenRequests[1].instructions ?? '', /Hotkey semantic retry requirements:/);
  assert.equal(seenRequests[1].promptCacheKey, 'k:blank-line-semicolon:sem1');
});

test('CompletionPipeline continues to full-stage semantic retry when fast-stage stays empty on a spacer line', async () => {
  const seenRequests = [];
  const provider = {
    async *streamCompletion(request) {
      seenRequests.push(request);
      if (seenRequests.length === 1) {
        yield { text: '', done: true };
        return;
      }
      if (seenRequests.length === 2) {
        yield { text: 'Mina")', done: false };
        yield { text: '', done: true };
        return;
      }
      yield { text: 'print(profile)', done: false };
      yield { text: '', done: true };
    },
  };

  const pipeline = new CompletionPipeline(provider);
  const result = await pipeline.getSuggestion({
    editorKey: '/tmp/file.py',
    contextHash: 'hash-hotkey-fallback-retry',
    fastRequest: {
      ...buildRequests().fastRequest,
      prefix: 'if __name__ == "__main__":\n    demo()\n    ',
      suffix: '',
      linePrefix: '    ',
      lineSuffix: '',
      interactionMode: 'hotkey',
    },
    fullRequestFactory: async () => ({
      ...await buildRequests().fullRequestFactory(),
      prefix:
        'def demo() -> None:\n'
        + '    profile = format_user(7, "Mina")\n'
        + '    print(profile)\n'
        + '    message = greet_user(\n'
        + '\n'
        + '\n'
        + 'if __name__ == "__main__":\n'
        + '    demo()\n'
        + '    ',
      suffix: '',
      linePrefix: '    ',
      lineSuffix: '',
      instructions: 'Return only inserted text.',
      promptCacheKey: 'k:fallback',
      interactionMode: 'hotkey',
    }),
    latencyBudget: buildLatencyBudget(),
    skipFastStage: false,
    hotkeySemanticRetry: {
      enabled: true,
      retryOnEmpty: true,
      maxLatencyMs: 120,
      firstChunkMaxLatencyMs: 80,
    },
    signal: new AbortController().signal,
  });

  assert.equal(result.suggestion, 'print(profile)');
  assert.equal(seenRequests.length, 3);
});

test('CompletionPipeline returns partial suggestion near max-latency deadline before timeout cancel', async () => {
  let secondChunkRequested = false;
  const provider = {
    async *streamCompletion() {
      await new Promise((resolve) => setTimeout(resolve, 70));
      yield { text: ' query', done: false };
      secondChunkRequested = true;
      await new Promise((resolve) => setTimeout(resolve, 100));
      yield { text: ' trailing', done: false };
      yield { text: '', done: true };
    },
  };

  const pipeline = new CompletionPipeline(provider);
  const result = await pipeline.getSuggestion({
    editorKey: '/tmp/file.py',
    contextHash: 'hash-near-deadline-partial',
    ...buildRequests(),
    latencyBudget: {
      maxLatencyMs: 90,
      firstChunkMaxLatencyMs: 90,
      fastStageMaxLatencyMs: 90,
    },
    skipFastStage: true,
    signal: new AbortController().signal,
  });

  assert.equal(result.suggestion, ' query');
  assert.equal(result.timedOutBeforeFirstChunk, false);
  assert.equal(secondChunkRequested, false);
});

test('CompletionPipeline shares total deadline across fast and full fallback stages', async () => {
  const seenContexts = [];
  const provider = {
    async *streamCompletion(request, signal) {
      seenContexts.push(request.context);
      if (request.context === undefined) {
        await new Promise((resolve) => setTimeout(resolve, 85));
        if (signal.aborted) {
          throw new Error('Request cancelled');
        }
        yield { text: 'late-fast', done: false };
        yield { text: '', done: true };
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
      if (signal.aborted) {
        throw new Error('Request cancelled');
      }
      yield { text: 'late-full', done: false };
      yield { text: '', done: true };
    },
  };

  const pipeline = new CompletionPipeline(provider);
  const result = await pipeline.getSuggestion({
    editorKey: '/tmp/file.py',
    contextHash: 'hash-shared-total-deadline',
    ...buildRequests(),
    latencyBudget: {
      maxLatencyMs: 100,
      firstChunkMaxLatencyMs: 100,
      fastStageMaxLatencyMs: 80,
    },
    skipFastStage: false,
    signal: new AbortController().signal,
  });

  assert.equal(result.suggestion, '');
  assert.equal(result.timedOutBeforeFirstChunk, true);
  assert.deepEqual(seenContexts, [undefined, 'full-context']);
});

test('CompletionPipeline resets hotkey full-stage budget after fast-stage first-token timeout', async () => {
  const seenContexts = [];
  const provider = {
    async *streamCompletion(request, signal) {
      seenContexts.push(request.context);
      if (request.context === undefined) {
        await new Promise((resolve) => setTimeout(resolve, 45));
        if (signal.aborted) {
          throw new Error('Request cancelled');
        }
        yield { text: 'late-fast', done: false };
        yield { text: '', done: true };
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 95));
      if (signal.aborted) {
        throw new Error('Request cancelled');
      }
      yield { text: 'from-full', done: false };
      yield { text: '', done: true };
    },
  };

  const pipeline = new CompletionPipeline(provider);
  const result = await pipeline.getSuggestion({
    editorKey: '/tmp/file.py',
    contextHash: 'hash-hotkey-budget-reset',
    fastRequest: {
      prefix: 'message = greet_user(',
      suffix: '',
      linePrefix: 'message = greet_user(',
      lineSuffix: '',
      languageId: 'python',
      filePath: '/tmp/test.py',
      context: undefined,
      instructions: 'Return only inserted text.',
      promptCacheKey: 'k:hotkey-budget-reset',
      priority: 'high',
      interactionMode: 'hotkey',
    },
    fullRequestFactory: async () => ({
      prefix: 'profile = format_user(user)\nmessage = greet_user(',
      suffix: '',
      linePrefix: 'message = greet_user(',
      lineSuffix: '',
      languageId: 'python',
      filePath: '/tmp/test.py',
      context: 'full-context',
      instructions: 'Return only inserted text.',
      promptCacheKey: 'k:hotkey-budget-reset',
      priority: 'high',
      interactionMode: 'hotkey',
    }),
    latencyBudget: {
      maxLatencyMs: 120,
      firstChunkMaxLatencyMs: 120,
      fastStageMaxLatencyMs: 40,
    },
    skipFastStage: false,
    signal: new AbortController().signal,
  });

  assert.equal(result.suggestion, 'from-full');
  assert.equal(result.timedOutBeforeFirstChunk, false);
  assert.deepEqual(seenContexts, [undefined, 'full-context']);
});

test('CompletionPipeline extends first-chunk timeout after progress events', async () => {
  const provider = {
    async *streamCompletion(_request, signal) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      if (signal.aborted) {
        throw new Error('Request cancelled');
      }
      yield { text: '', done: false, progress: true };
      await new Promise((resolve) => setTimeout(resolve, 70));
      if (signal.aborted) {
        throw new Error('Request cancelled');
      }
      yield { text: 'ok', done: false };
      yield { text: '', done: true };
    },
  };

  const pipeline = new CompletionPipeline(provider);
  const result = await pipeline.getSuggestion({
    editorKey: '/tmp/file.py',
    contextHash: 'hash-progress-extension',
    ...buildRequests(),
    latencyBudget: {
      maxLatencyMs: 220,
      firstChunkMaxLatencyMs: 60,
      fastStageMaxLatencyMs: 220,
    },
    skipFastStage: true,
    signal: new AbortController().signal,
  });

  assert.equal(result.suggestion, 'ok');
  assert.equal(result.timedOutBeforeFirstChunk, false);
});

test('CompletionPipeline extends first-chunk timeout when progress arrives early', async () => {
  const provider = {
    async *streamCompletion(_request, signal) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      if (signal.aborted) {
        throw new Error('Request cancelled');
      }
      yield { text: '', done: false, progress: true };
      await new Promise((resolve) => setTimeout(resolve, 1420));
      if (signal.aborted) {
        throw new Error('Request cancelled');
      }
      yield { text: 'ok', done: false };
      yield { text: '', done: true };
    },
  };

  const pipeline = new CompletionPipeline(provider);
  const result = await pipeline.getSuggestion({
    editorKey: '/tmp/file.py',
    contextHash: 'hash-progress-early-extension',
    ...buildRequests(),
    latencyBudget: {
      maxLatencyMs: 2000,
      firstChunkMaxLatencyMs: 1400,
      fastStageMaxLatencyMs: 2000,
    },
    skipFastStage: true,
    signal: new AbortController().signal,
  });

  assert.equal(result.suggestion, 'ok');
  assert.equal(result.timedOutBeforeFirstChunk, false);
});

test('CompletionPipeline logs effective first-chunk deadline after progress extension timeout', async () => {
  const previousLevel = getCodexLogLevel();
  const captured = [];
  const originalLog = console.log;
  console.log = (message) => captured.push(message);

  try {
    setCodexLogLevel('info');
    const provider = {
      async *streamCompletion(_request, signal) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (signal.aborted) {
          throw new Error('Request cancelled');
        }
        yield { text: '', done: false, progress: true };
        await new Promise((resolve) => setTimeout(resolve, 160));
        if (signal.aborted) {
          throw new Error('Request cancelled');
        }
        yield { text: 'late', done: false };
        yield { text: '', done: true };
      },
    };

    const pipeline = new CompletionPipeline(provider);
    const result = await pipeline.getSuggestion({
      editorKey: '/tmp/file.py',
      contextHash: 'hash-progress-timeout-log',
      ...buildRequests(),
      latencyBudget: {
        maxLatencyMs: 120,
        firstChunkMaxLatencyMs: 50,
        fastStageMaxLatencyMs: 120,
      },
      skipFastStage: true,
      signal: new AbortController().signal,
    });

    assert.equal(result.suggestion, '');
    assert.equal(result.timedOutBeforeFirstChunk, true);
  } finally {
    setCodexLogLevel(previousLevel);
    console.log = originalLog;
  }

  assert.ok(
    captured.some((line) =>
      line.includes('inline timeout before first chunk effectiveDeadline=120ms base=50ms extensions=1')),
    `missing effective first-chunk deadline log in:\n${captured.join('\n')}`,
  );
  assert.ok(
    captured.some((line) =>
      line.includes('full max-latency timer fired elapsed=')
      && line.includes('budget=120ms')),
    `missing max-latency timer fire log in:\n${captured.join('\n')}`,
  );
});

test('CompletionPipeline logs first-chunk timer fire when it expires before total timeout', async () => {
  const previousLevel = getCodexLogLevel();
  const captured = [];
  const originalLog = console.log;
  console.log = (message) => captured.push(message);

  try {
    setCodexLogLevel('info');
    const provider = {
      async *streamCompletion(_request, signal) {
        await new Promise((resolve) => setTimeout(resolve, 80));
        if (signal.aborted) {
          throw new Error('Request cancelled');
        }
        yield { text: 'late', done: false };
        yield { text: '', done: true };
      },
    };

    const pipeline = new CompletionPipeline(provider);
    const result = await pipeline.getSuggestion({
      editorKey: '/tmp/file.py',
      contextHash: 'hash-first-chunk-fire-log',
      ...buildRequests(),
      latencyBudget: {
        maxLatencyMs: 150,
        firstChunkMaxLatencyMs: 50,
        fastStageMaxLatencyMs: 150,
      },
      skipFastStage: true,
      signal: new AbortController().signal,
    });

    assert.equal(result.suggestion, '');
    assert.equal(result.timedOutBeforeFirstChunk, true);
  } finally {
    setCodexLogLevel(previousLevel);
    console.log = originalLog;
  }

  assert.ok(
    captured.some((line) =>
      line.includes('full first-chunk timer fired elapsed=')
      && line.includes('effectiveDeadline=50ms base=50ms extensions=0')),
    `missing first-chunk timer fire log in:\n${captured.join('\n')}`,
  );
});
