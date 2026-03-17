import { CompletionMetrics } from '../performance/metrics';
import type { StageTelemetryEvent } from './completionPipeline';

interface InlineTelemetryState {
  total: number;
  emptyResults: number;
  firstChunkLatenciesMs: number[];
  fastStageAttempts: number;
  fastStageHits: number;
  fastStageFallbacks: number;
  fastStageLatenciesMs: number[];
  fullStageLatenciesMs: number[];
}

export class InlineTelemetry {
  private readonly state: InlineTelemetryState = {
    total: 0,
    emptyResults: 0,
    firstChunkLatenciesMs: [],
    fastStageAttempts: 0,
    fastStageHits: 0,
    fastStageFallbacks: 0,
    fastStageLatenciesMs: [],
    fullStageLatenciesMs: [],
  };

  recordFirstChunkLatency(valueMs: number): void {
    if (!Number.isFinite(valueMs) || valueMs < 0) {
      return;
    }

    this.state.total += 1;
    this.state.firstChunkLatenciesMs.push(valueMs);
    if (this.state.firstChunkLatenciesMs.length > 200) {
      this.state.firstChunkLatenciesMs.shift();
    }
  }

  recordEmptyResult(): void {
    this.state.total += 1;
    this.state.emptyResults += 1;
  }

  recordStageEvent(event: StageTelemetryEvent): void {
    if (!Number.isFinite(event.latencyMs) || event.latencyMs < 0) {
      return;
    }

    if (event.stage === 'fast') {
      if (event.outcome === 'hit' || event.outcome === 'empty' || event.outcome === 'error') {
        this.state.fastStageAttempts += 1;
        this.state.fastStageLatenciesMs.push(event.latencyMs);
        if (this.state.fastStageLatenciesMs.length > 200) {
          this.state.fastStageLatenciesMs.shift();
        }
        if (event.outcome === 'hit') {
          this.state.fastStageHits += 1;
        } else {
          this.state.fastStageFallbacks += 1;
        }
      }
      return;
    }

    if (event.stage === 'full' && event.outcome === 'completed') {
      this.state.fullStageLatenciesMs.push(event.latencyMs);
      if (this.state.fullStageLatenciesMs.length > 200) {
        this.state.fullStageLatenciesMs.shift();
      }
    }
  }

  buildDebugSnapshot(metrics: CompletionMetrics): {
    totals: ReturnType<CompletionMetrics['getSnapshot']>;
    emptyResultRate: number;
    firstChunkP50Ms: number;
    firstChunkP95Ms: number;
    fastStageHitRate: number;
    fastStageFallbackRate: number;
    fastStageP50Ms: number;
    fastStageP95Ms: number;
    fullStageRuns: number;
    fullStageP50Ms: number;
    fullStageP95Ms: number;
  } {
    const totals = metrics.getSnapshot();
    const denominator = Math.max(1, this.state.total);
    const fastStageDenominator = Math.max(1, this.state.fastStageAttempts);

    return {
      totals,
      emptyResultRate: this.state.emptyResults / denominator,
      firstChunkP50Ms: percentile(this.state.firstChunkLatenciesMs, 0.5),
      firstChunkP95Ms: percentile(this.state.firstChunkLatenciesMs, 0.95),
      fastStageHitRate: this.state.fastStageHits / fastStageDenominator,
      fastStageFallbackRate: this.state.fastStageFallbacks / fastStageDenominator,
      fastStageP50Ms: percentile(this.state.fastStageLatenciesMs, 0.5),
      fastStageP95Ms: percentile(this.state.fastStageLatenciesMs, 0.95),
      fullStageRuns: this.state.fullStageLatenciesMs.length,
      fullStageP50Ms: percentile(this.state.fullStageLatenciesMs, 0.5),
      fullStageP95Ms: percentile(this.state.fullStageLatenciesMs, 0.95),
    };
  }
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor((sorted.length - 1) * ratio)),
  );

  return sorted[index];
}
