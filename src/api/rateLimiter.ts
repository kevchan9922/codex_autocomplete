export interface RateLimiterConfig {
  maxRequests: number;
  windowMs: number;
}

export interface AcquireOptions {
  signal?: AbortSignal;
  priority?: 'high' | 'normal';
}

interface QueueEntry {
  resolve: () => void;
  reject: (error: Error) => void;
  priority: 'high' | 'normal';
  sequence: number;
  signal?: AbortSignal;
  abortHandler?: () => void;
}

const DEFAULT_CONFIG: RateLimiterConfig = {
  maxRequests: 5,
  windowMs: 10_000,
};

export class RateLimiter {
  private readonly capacity: number;
  private readonly refillTokensPerMs: number;
  private tokens: number;
  private lastRefillAt: number;
  private readonly queue: QueueEntry[] = [];
  private sequence = 0;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(config: Partial<RateLimiterConfig> = {}) {
    this.capacity = config.maxRequests ?? DEFAULT_CONFIG.maxRequests;
    const windowMs = config.windowMs ?? DEFAULT_CONFIG.windowMs;
    this.refillTokensPerMs = this.capacity / windowMs;
    this.tokens = this.capacity;
    this.lastRefillAt = Date.now();
  }

  async acquire(signalOrOptions?: AbortSignal | AcquireOptions): Promise<void> {
    const options = normalizeAcquireOptions(signalOrOptions);
    this.throwIfAborted(options.signal);

    this.refill();
    if (this.tokens >= 1 && this.queue.length === 0) {
      this.tokens -= 1;
      return;
    }

    return new Promise<void>((resolve, reject) => {
      const entry: QueueEntry = {
        resolve: () => {
          detachAbortHandler(entry);
          resolve();
        },
        reject: (error: Error) => {
          detachAbortHandler(entry);
          reject(error);
        },
        priority: options.priority ?? 'normal',
        sequence: this.sequence++,
        signal: options.signal,
      };

      if (options.signal) {
        entry.abortHandler = () => {
          this.removeQueuedEntry(entry);
          entry.reject(new Error('Request cancelled'));
        };
        options.signal.addEventListener('abort', entry.abortHandler);
      }

      this.queue.push(entry);
      this.scheduleFlush();
      this.flushQueue();
    });
  }

  private refill(): void {
    const now = Date.now();
    const elapsedMs = now - this.lastRefillAt;
    if (elapsedMs <= 0) {
      return;
    }

    this.tokens = Math.min(this.capacity, this.tokens + elapsedMs * this.refillTokensPerMs);
    this.lastRefillAt = now;
  }

  private flushQueue(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }

    this.refill();
    while (this.tokens >= 1 && this.queue.length > 0) {
      const nextIndex = this.nextQueueIndex();
      const [entry] = this.queue.splice(nextIndex, 1);
      this.tokens -= 1;
      entry.resolve();
    }

    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.queue.length === 0 || this.flushTimer) {
      return;
    }

    this.refill();
    if (this.tokens >= 1) {
      this.flushQueue();
      return;
    }

    const waitMs = Math.max(1, Math.ceil((1 - this.tokens) / this.refillTokensPerMs));
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flushQueue();
    }, waitMs);
  }

  private nextQueueIndex(): number {
    let bestIndex = 0;

    for (let index = 1; index < this.queue.length; index += 1) {
      const candidate = this.queue[index];
      const currentBest = this.queue[bestIndex];

      if (candidate.priority === 'high' && currentBest.priority === 'normal') {
        bestIndex = index;
        continue;
      }

      if (candidate.priority === currentBest.priority && candidate.sequence < currentBest.sequence) {
        bestIndex = index;
      }
    }

    return bestIndex;
  }

  private removeQueuedEntry(target: QueueEntry): void {
    const index = this.queue.indexOf(target);
    if (index >= 0) {
      this.queue.splice(index, 1);
    }
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new Error('Request cancelled');
    }
  }
}

function normalizeAcquireOptions(signalOrOptions?: AbortSignal | AcquireOptions): AcquireOptions {
  if (!signalOrOptions) {
    return { signal: undefined, priority: 'normal' };
  }

  if (isAcquireOptions(signalOrOptions)) {
    const options = signalOrOptions;
    return {
      signal: options.signal,
      priority: options.priority ?? 'normal',
    };
  }

  return {
    signal: signalOrOptions as AbortSignal,
    priority: 'normal',
  };
}

function isAcquireOptions(value: AbortSignal | AcquireOptions): value is AcquireOptions {
  return typeof (value as AcquireOptions).priority === 'string' ||
    Object.prototype.hasOwnProperty.call(value, 'signal');
}

function detachAbortHandler(entry: QueueEntry): void {
  if (entry.abortHandler) {
    entry.signal?.removeEventListener('abort', entry.abortHandler);
  }
}
