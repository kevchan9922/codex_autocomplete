require('./helpers/registerVscode.js');

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildLatencyBudget } = require('../out/completion/latencyBudget.js');

test('buildLatencyBudget uses the extended inline timing profile', () => {
  const budget = buildLatencyBudget(
    {
      maxLatencyMs: 1800,
      firstChunkMaxLatencyMs: 1400,
      fastStageMaxLatencyMs: 500,
    },
  );

  assert.deepEqual(budget, {
    maxLatencyMs: 6000,
    firstChunkMaxLatencyMs: 1800,
    fastStageMaxLatencyMs: 2000,
  });
});

test('buildLatencyBudget keeps larger first-chunk budgets within the extended cap', () => {
  const budget = buildLatencyBudget(
    {
      maxLatencyMs: 5000,
      firstChunkMaxLatencyMs: 3200,
      fastStageMaxLatencyMs: 500,
    },
  );

  assert.equal(budget.maxLatencyMs, 6000);
  assert.equal(budget.fastStageMaxLatencyMs, 2000);
  assert.equal(budget.firstChunkMaxLatencyMs, 2200);
});

test('buildLatencyBudget still normalizes invalid input before applying the extended profile', () => {
  const budget = buildLatencyBudget(
    {
      maxLatencyMs: 120,
      firstChunkMaxLatencyMs: 250,
      fastStageMaxLatencyMs: 180,
    },
  );

  assert.equal(budget.maxLatencyMs, 6000);
  assert.equal(budget.fastStageMaxLatencyMs, 2000);
  assert.equal(budget.firstChunkMaxLatencyMs, 1800);
});
