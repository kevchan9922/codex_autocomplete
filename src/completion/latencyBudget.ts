import { codexLog } from '../logging/codexLogger';

export interface StageLatencyBudget {
  maxLatencyMs: number;
  firstChunkMaxLatencyMs: number;
}

export interface LatencyBudget extends StageLatencyBudget {
  fastStageMaxLatencyMs: number;
}

const EXTENDED_MIN_TOTAL_MAX_LATENCY_MS = 6000;
const EXTENDED_MIN_FIRST_CHUNK_MAX_LATENCY_MS = 1800;
const EXTENDED_MAX_FIRST_CHUNK_MAX_LATENCY_MS = 2200;
const EXTENDED_FAST_STAGE_MAX_LATENCY_MS = 2000;

function clampLatencyMs(value: number): number {
  return Math.max(1, value);
}

function clampLatencyRange(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function normalizeStageLatencyBudget(budget: StageLatencyBudget): StageLatencyBudget {
  const maxLatencyMs = clampLatencyMs(budget.maxLatencyMs);
  return {
    maxLatencyMs,
    firstChunkMaxLatencyMs: clampLatencyRange(budget.firstChunkMaxLatencyMs, 1, maxLatencyMs),
  };
}

export function buildLatencyBudget(
  config: LatencyBudget,
): LatencyBudget {
  const baseStageBudget = normalizeStageLatencyBudget({
    maxLatencyMs: config.maxLatencyMs,
    firstChunkMaxLatencyMs: config.firstChunkMaxLatencyMs,
  });

  // All inline requests use the extended staged budget profile.
  const extendedStageBudget = normalizeStageLatencyBudget({
    maxLatencyMs: Math.max(baseStageBudget.maxLatencyMs, EXTENDED_MIN_TOTAL_MAX_LATENCY_MS),
    firstChunkMaxLatencyMs: clampLatencyRange(
      baseStageBudget.firstChunkMaxLatencyMs,
      EXTENDED_MIN_FIRST_CHUNK_MAX_LATENCY_MS,
      EXTENDED_MAX_FIRST_CHUNK_MAX_LATENCY_MS,
    ),
  });
  const fastStageMaxLatencyMs = clampLatencyRange(
    EXTENDED_FAST_STAGE_MAX_LATENCY_MS,
    1,
    extendedStageBudget.maxLatencyMs,
  );

  codexLog(
    `[codex] inline latency budget fast=${fastStageMaxLatencyMs}ms full=${extendedStageBudget.maxLatencyMs}ms firstChunk=${extendedStageBudget.firstChunkMaxLatencyMs}ms`,
  );

  return {
    ...extendedStageBudget,
    fastStageMaxLatencyMs,
  };
}
