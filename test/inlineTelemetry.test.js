require('./helpers/registerVscode.js');

const test = require('node:test');
const assert = require('node:assert/strict');

const { InlineTelemetry } = require('../out/completion/inlineTelemetry.js');
const { CompletionMetrics } = require('../out/performance/metrics.js');

test('InlineTelemetry tracks empty-result rate and percentile snapshots', () => {
  const telemetry = new InlineTelemetry();
  const metrics = new CompletionMetrics();

  telemetry.recordFirstChunkLatency(10);
  telemetry.recordFirstChunkLatency(20);
  telemetry.recordFirstChunkLatency(30);
  telemetry.recordEmptyResult();
  telemetry.recordFirstChunkLatency(-1);
  telemetry.recordStageEvent({ stage: 'fast', outcome: 'hit', latencyMs: 40 });
  telemetry.recordStageEvent({ stage: 'fast', outcome: 'empty', latencyMs: 80 });
  telemetry.recordStageEvent({
    stage: 'full',
    outcome: 'completed',
    latencyMs: 120,
    reason: 'fallback_after_empty',
  });

  const request = metrics.beginRequest();
  request.endSuccess('ok');

  const snapshot = telemetry.buildDebugSnapshot(metrics);

  assert.equal(snapshot.totals.successfulRequests, 1);
  assert.equal(snapshot.emptyResultRate, 0.25);
  assert.equal(snapshot.firstChunkP50Ms, 20);
  assert.equal(snapshot.firstChunkP95Ms, 20);
  assert.equal(snapshot.fastStageHitRate, 0.5);
  assert.equal(snapshot.fastStageFallbackRate, 0.5);
  assert.equal(snapshot.fastStageP50Ms, 40);
  assert.equal(snapshot.fullStageRuns, 1);
  assert.equal(snapshot.fullStageP50Ms, 120);
});
