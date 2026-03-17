export function mergeAbortSignals(...signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();

  const onAbort = (): void => {
    controller.abort();
    for (const signal of signals) {
      signal.removeEventListener('abort', onAbort);
    }
  };

  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort();
      return controller.signal;
    }
    signal.addEventListener('abort', onAbort);
  }

  return controller.signal;
}

export function isRequestCancelled(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (message.includes('cancelled') || message.includes('aborted')) {
      return true;
    }
  }

  return typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: string }).name === 'AbortError';
}
