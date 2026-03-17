interface ActiveRequest {
  controller: AbortController;
  version: number;
  cancelReason?: string;
}

export interface BeginRequestOptions {
  supersedeReason?: string;
}

export interface RequestHandle {
  signal: AbortSignal;
  version: number;
  isLatest(): boolean;
  getAbortReason(): string | undefined;
  release(): void;
}

export class CancellationManager {
  private readonly activeByEditor = new Map<string, ActiveRequest>();

  begin(editorKey: string, options: BeginRequestOptions = {}): RequestHandle {
    const current = this.activeByEditor.get(editorKey);
    if (current) {
      this.abortActive(current, options.supersedeReason ?? 'cancelled_by_new_request');
    }

    const nextVersion = (current?.version ?? 0) + 1;
    const next: ActiveRequest = {
      controller: new AbortController(),
      version: nextVersion,
    };

    this.activeByEditor.set(editorKey, next);

    return this.buildHandle(editorKey, next);
  }

  cancel(editorKey: string, reason = 'cancelled_by_editor'): void {
    const current = this.activeByEditor.get(editorKey);
    if (!current) {
      return;
    }

    this.abortActive(current, reason);
    this.activeByEditor.delete(editorKey);
  }

  cancelAll(reason = 'cancelled_by_dispose'): void {
    for (const active of this.activeByEditor.values()) {
      this.abortActive(active, reason);
    }
    this.activeByEditor.clear();
  }

  private abortActive(active: ActiveRequest, reason: string): void {
    if (!active.cancelReason) {
      active.cancelReason = reason;
    }
    active.controller.abort();
  }

  private buildHandle(
    editorKey: string,
    active: ActiveRequest,
  ): RequestHandle {
    return {
      signal: active.controller.signal,
      version: active.version,
      isLatest: () => this.activeByEditor.get(editorKey) === active,
      getAbortReason: () => active.cancelReason,
      release: () => {
        if (this.activeByEditor.get(editorKey) === active) {
          this.activeByEditor.delete(editorKey);
        }
      },
    };
  }
}
