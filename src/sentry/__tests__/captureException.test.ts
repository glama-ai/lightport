import { captureException } from '../captureException';
import type { ErrorEvent } from '@sentry/core';
import * as Sentry from '@sentry/node-core/light';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

const events: ErrorEvent[] = [];

beforeAll(() => {
  Sentry.init({
    // Mirrors initializeSentry closely enough to exercise the real
    // LinkedErrors integration, which is what expands `error.cause` into
    // extra `event.exception.values` entries ahead of captureException's own
    // event processor.
    attachStacktrace: true,
    beforeSend: (event) => {
      events.push(event);
      return null;
    },
    dsn: 'https://public@example.invalid/1',
    tracesSampleRate: 0,
  });
});

beforeEach(() => {
  events.length = 0;
});

const flush = async () => {
  await Sentry.flush(2_000);
};

describe('cause chains on captured errors', () => {
  it('keeps each cause message distinct instead of overwriting every entry', async () => {
    const error = new TypeError('fetch failed', { cause: new Error('read ECONNRESET') });

    captureException({ error, message: 'chatCompletions handler error' });

    await flush();

    const values = events[0].exception?.values ?? [];

    expect(values).toHaveLength(2);
    // Index 0 is the deepest cause: LinkedErrors prepends it ahead of the
    // error that was actually thrown.
    expect(values[0].type).toBe('Error');
    expect(values[0].value).toBe('read ECONNRESET');
    // The last entry is the thrown error itself, which is the one call sites
    // mean to relabel with their own, more specific message.
    expect(values.at(-1)?.type).toBe('TypeError');
    expect(values.at(-1)?.value).toBe('chatCompletions handler error');
  });

  it('still relabels a lone exception with no cause chain', async () => {
    captureException({ error: new Error('read ECONNRESET'), message: 'chatCompletions handler error' });

    await flush();

    const values = events[0].exception?.values ?? [];

    expect(values).toHaveLength(1);
    expect(values[0].value).toBe('chatCompletions handler error');
  });

  it('walks a multi-level cause chain without touching any but the last entry', async () => {
    const error = new Error('chatCompletions handler error', {
      cause: new TypeError('fetch failed', { cause: new Error('read ECONNRESET') }),
    });

    captureException({ error, message: 'chatCompletions handler error' });

    await flush();

    const values = events[0].exception?.values ?? [];

    expect(values).toHaveLength(3);
    expect(values[0].value).toBe('read ECONNRESET');
    expect(values[1].value).toBe('fetch failed');
    expect(values.at(-1)?.value).toBe('chatCompletions handler error');
  });

  it('surfaces the thrown error’s own message as extra even when its title is overridden', async () => {
    const error = new TypeError('fetch failed', { cause: new Error('read ECONNRESET') });

    captureException({ error, message: 'chatCompletions handler error' });

    await flush();

    // Not the wrapper's message -- that's already sitting in exception.value.
    // This is the text the override just erased from the thrown error itself.
    expect(events[0].extra?.originalMessage).toBe('fetch failed');
  });

  it('serializes the cause chain into extra as a defense against LinkedErrors truncating it', async () => {
    const error = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
    });

    captureException({ error, message: 'chatCompletions handler error' });

    await flush();

    expect(events[0].extra?.causeChain).toEqual([
      { code: 'ECONNRESET', message: 'read ECONNRESET', name: 'Error' },
    ]);
  });

  it('omits causeChain entirely for a lone exception', async () => {
    captureException({ error: new Error('boom'), message: 'boom' });

    await flush();

    expect(events[0].extra?.causeChain).toBeUndefined();
  });
});
