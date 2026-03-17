export interface CompletionMetricsSnapshot {
  totalRequests: number;
  successfulRequests: number;
  cancelledRequests: number;
  erroredRequests: number;
  totalDurationMs: number;
  totalEstimatedTokens: number;
}

export interface RequestMetricsHandle {
  endSuccess(outputText: string): void;
  endCancelled(): void;
  endError(): void;
}

export class CompletionMetrics {
  private snapshot: CompletionMetricsSnapshot = {
    totalRequests: 0,
    successfulRequests: 0,
    cancelledRequests: 0,
    erroredRequests: 0,
    totalDurationMs: 0,
    totalEstimatedTokens: 0,
  };

  beginRequest(): RequestMetricsHandle {
    const startedAt = Date.now();
    this.snapshot.totalRequests += 1;

    let completed = false;
    const finish = (type: 'success' | 'cancel' | 'error', outputText?: string): void => {
      if (completed) {
        return;
      }

      completed = true;
      this.snapshot.totalDurationMs += Date.now() - startedAt;

      if (type === 'success') {
        this.snapshot.successfulRequests += 1;
        this.snapshot.totalEstimatedTokens += estimateTokens(outputText ?? '');
        return;
      }

      if (type === 'cancel') {
        this.snapshot.cancelledRequests += 1;
        return;
      }

      this.snapshot.erroredRequests += 1;
    };

    return {
      endSuccess: (outputText: string) => finish('success', outputText),
      endCancelled: () => finish('cancel'),
      endError: () => finish('error'),
    };
  }

  getSnapshot(): CompletionMetricsSnapshot {
    return { ...this.snapshot };
  }
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
