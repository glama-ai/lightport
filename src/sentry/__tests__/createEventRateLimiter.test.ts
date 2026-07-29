import { createEventRateLimiter } from '../createEventRateLimiter';
import type { ErrorEvent } from '@sentry/core';
import { describe, expect, it } from 'vitest';

/**
 * Shapes a fixture the way captureException leaves a real cause chain after
 * its own fix: the deepest cause first with mechanism `chained`, the thrown
 * error last with whatever mechanism it already had.
 */
const chainedEvent = (deepestMessage: string, thrownMessage: string): ErrorEvent => ({
  exception: {
    values: [
      { mechanism: { handled: true, type: 'chained' }, type: 'Error', value: deepestMessage },
      { mechanism: { handled: true, type: 'generic' }, type: 'TypeError', value: thrownMessage },
    ],
  },
});

const loneEvent = (message: string): ErrorEvent => ({
  exception: {
    values: [{ mechanism: { handled: true, type: 'generic' }, type: 'Error', value: message }],
  },
});

describe('createEventRateLimiter grouping key', () => {
  it('buckets a cause chain by the thrown error, not the deepest cause', () => {
    const limiter = createEventRateLimiter({ globalMaxPerWindow: 100, maxPerWindow: 2, windowMs: 60_000 });

    // Same thrown error, different deepest cause each time -- these have to
    // count against the same bucket rather than each getting their own quota.
    expect(limiter(chainedEvent('read ECONNRESET', 'chatCompletions handler error'), {})).not.toBeNull();
    expect(limiter(chainedEvent('read ETIMEDOUT', 'chatCompletions handler error'), {})).not.toBeNull();
    expect(limiter(chainedEvent('socket hang up', 'chatCompletions handler error'), {})).toBeNull();
  });

  it('keeps an unrelated error out of that bucket', () => {
    const limiter = createEventRateLimiter({ globalMaxPerWindow: 100, maxPerWindow: 1, windowMs: 60_000 });

    expect(limiter(chainedEvent('read ECONNRESET', 'chatCompletions handler error'), {})).not.toBeNull();
    expect(limiter(loneEvent('failed to validate request'), {})).not.toBeNull();
  });

  it('still limits a lone exception with no cause chain', () => {
    const limiter = createEventRateLimiter({ globalMaxPerWindow: 100, maxPerWindow: 1, windowMs: 60_000 });

    expect(limiter(loneEvent('boom'), {})).not.toBeNull();
    expect(limiter(loneEvent('boom'), {})).toBeNull();
  });
});
