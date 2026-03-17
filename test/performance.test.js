require('./helpers/registerVscode.js');

const test = require('node:test');
const assert = require('node:assert/strict');

const { CompletionMetrics } = require('../out/performance/metrics.js');

test('CompletionMetrics records duration, cancel, error and token estimate', async () => {
  const metrics = new CompletionMetrics();

  const success = metrics.beginRequest();
  await new Promise((resolve) => setTimeout(resolve, 10));
  success.endSuccess('abcdefgh');

  const cancelled = metrics.beginRequest();
  cancelled.endCancelled();

  const errored = metrics.beginRequest();
  errored.endError();

  const snapshot = metrics.getSnapshot();
  assert.equal(snapshot.totalRequests, 3);
  assert.equal(snapshot.successfulRequests, 1);
  assert.equal(snapshot.cancelledRequests, 1);
  assert.equal(snapshot.erroredRequests, 1);
  assert.ok(snapshot.totalDurationMs >= 1);
  assert.equal(snapshot.totalEstimatedTokens, 2);
});
