require('./helpers/registerVscode.js');

const test = require('node:test');
const assert = require('node:assert/strict');

const { RateLimiter } = require('../out/api/rateLimiter.js');

test('RateLimiter throttles requests beyond configured window capacity', async () => {
  const limiter = new RateLimiter({ maxRequests: 2, windowMs: 60 });

  const start = Date.now();
  await limiter.acquire();
  await limiter.acquire();
  await limiter.acquire();

  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 25, `expected throttling delay, got ${elapsed}ms`);
});

test('RateLimiter aborts waiting acquire when signal is cancelled', async () => {
  const limiter = new RateLimiter({ maxRequests: 1, windowMs: 1_000 });
  await limiter.acquire();

  const controller = new AbortController();
  const pending = limiter.acquire(controller.signal);
  controller.abort();

  await assert.rejects(() => pending, /Request cancelled/);
});

test('RateLimiter prioritizes high priority queued acquires', async () => {
  const limiter = new RateLimiter({ maxRequests: 1, windowMs: 80 });
  await limiter.acquire();

  const order = [];
  const lowPromise = limiter.acquire({ priority: 'normal' }).then(() => order.push('low'));
  const highPromise = limiter.acquire({ priority: 'high' }).then(() => order.push('high'));

  await Promise.all([lowPromise, highPromise]);
  assert.deepEqual(order, ['high', 'low']);
});

test('RateLimiter preserves FIFO order within same priority', async () => {
  const limiter = new RateLimiter({ maxRequests: 1, windowMs: 80 });
  await limiter.acquire();

  const order = [];
  const first = limiter.acquire({ priority: 'normal' }).then(() => order.push('first'));
  const second = limiter.acquire({ priority: 'normal' }).then(() => order.push('second'));

  await Promise.all([first, second]);
  assert.deepEqual(order, ['first', 'second']);
});

test('RateLimiter rejects immediately for pre-aborted signal in AcquireOptions', async () => {
  const limiter = new RateLimiter({ maxRequests: 1, windowMs: 1_000 });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => limiter.acquire({ signal: controller.signal }),
    /Request cancelled/,
  );
});
