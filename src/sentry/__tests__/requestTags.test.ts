import createApp from '../../index';
import { captureException } from '../captureException';
import { setRequestTags } from '../setRequestTags';
import { withRequestScope } from '../withRequestScope';
import type { ErrorEvent } from '@sentry/core';
import * as Sentry from '@sentry/node-core/light';
import getPort from 'get-port';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const events: ErrorEvent[] = [];
const apps: Array<ReturnType<typeof createApp>> = [];

beforeAll(() => {
  Sentry.init({
    // Collects events at the last point before egress, then drops them so the
    // unreachable DSN is never dialled.
    beforeSend: (event) => {
      events.push(event);
      return null;
    },
    dsn: 'https://public@example.invalid/1',
  });
});

beforeEach(() => {
  events.length = 0;
});

afterEach(async () => {
  await Promise.all(
    apps.splice(0).map(async (app) => {
      await app.close();
    }),
  );
});

/** Event processing is async even when `beforeSend` drops the event. */
const flush = async () => {
  await Sentry.flush(2_000);
};

const capturedIn = async (tags: Parameters<typeof setRequestTags>[0]) => {
  await withRequestScope(async () => {
    setRequestTags(tags);
    captureException({ error: new Error('boom'), message: 'boom' });
  });

  await flush();

  return events[0].tags ?? {};
};

describe('setRequestTags', () => {
  it('truncates values that exceed the Sentry tag limit', async () => {
    const tags = await capturedIn({ model: 'm'.repeat(500) });

    expect(tags.model).toHaveLength(200);
  });

  it('collapses whitespace, which Sentry rejects in tag values', async () => {
    const tags = await capturedIn({ model: 'gpt-4o\nwith\twhitespace' });

    expect(tags.model).toBe('gpt-4o with whitespace');
  });

  it('drops non-string values rather than tagging them', async () => {
    const tags = await capturedIn({ model: { nested: 'object' }, provider: 42 });

    expect(tags.model).toBeUndefined();
    expect(tags.provider).toBeUndefined();
  });

  it('skips absent values instead of clearing what an earlier call established', async () => {
    await withRequestScope(async () => {
      setRequestTags({ provider: 'openai' });
      setRequestTags({ model: 'gpt-4o', provider: undefined });
      captureException({ error: new Error('boom'), message: 'boom' });
    });

    await flush();

    expect(events[0].tags).toMatchObject({ model: 'gpt-4o', provider: 'openai' });
  });

  it('keeps tags from leaking across concurrent requests', async () => {
    const ids = ['alpha', 'beta', 'gamma'];

    await Promise.all(
      ids.map((id) =>
        withRequestScope(async () => {
          setRequestTags({ provider: id, traceId: id });
          // Interleave, so a shared scope would show up as crossed tags.
          await new Promise((resolve) => setTimeout(resolve, 10));
          captureException({ error: new Error(id), message: id });
        }),
      ),
    );

    await flush();

    expect(events).toHaveLength(3);

    for (const event of events) {
      // captureException rewrites the exception value to the message, so this
      // asserts each event carries the tags of the request that raised it.
      const raisedBy = event.exception?.values?.[0]?.value;

      expect(event.tags?.provider).toBe(raisedBy);
      expect(event.tags?.trace_id).toBe(raisedBy);
    }

    expect(new Set(events.map((event) => event.tags?.provider))).toEqual(new Set(ids));
  });
});

describe('gateway request tags', () => {
  it('tags exceptions raised before a provider is ever resolved', async () => {
    const app = createApp();
    apps.push(app);

    const response = await app.inject({
      headers: {
        'content-type': 'application/json',
        'x-lightport-config': '{not valid json',
        'x-lightport-provider': 'openai',
        'x-lightport-trace-id': 'trace-abc',
      },
      method: 'POST',
      payload: { messages: [], model: 'gpt-4o' },
      url: '/v1/chat/completions',
    });

    expect(response.statusCode).toBe(400);

    await flush();

    expect(events).toHaveLength(1);
    expect(events[0].tags).toMatchObject({
      model: 'gpt-4o',
      provider: 'openai',
      route: '/v1/chat/completions',
      stream: 'false',
      trace_id: 'trace-abc',
    });
  });

  it('keeps tags isolated across concurrent requests on a real HTTP listener', async () => {
    // `app.inject` never touches the HTTP server, and so never engages Sentry's
    // httpIntegration, which forks an isolation scope of its own around ours.
    // Production has both, so this covers the nesting.
    const port = await getPort();
    const app = createApp();
    apps.push(app);
    await app.listen({ host: '127.0.0.1', port });

    const ids = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];

    await Promise.all(
      ids.map(async (id) => {
        const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          body: JSON.stringify({ messages: [], model: `model-${id}` }),
          headers: {
            'content-type': 'application/json',
            'x-lightport-config': '{not valid json',
            'x-lightport-provider': 'openai',
            'x-lightport-trace-id': `trace-${id}`,
          },
          method: 'POST',
        });

        expect(response.status).toBe(400);
      }),
    );

    await flush();

    expect(events).toHaveLength(ids.length);

    for (const event of events) {
      // Both tags come from the same request, so they must name the same id.
      const raisedBy = String(event.tags?.trace_id).replace('trace-', '');

      expect(event.tags?.model).toBe(`model-${raisedBy}`);
    }

    expect(new Set(events.map((event) => event.tags?.trace_id))).toEqual(
      new Set(ids.map((id) => `trace-${id}`)),
    );
  });

  it('tags exceptions with the endpoint and provider resolved by tryPost', async () => {
    // Nothing is listening here, so the provider fetch fails without leaving the
    // machine and tryPost throws with its tags already set.
    const deadPort = await getPort();
    const app = createApp();
    apps.push(app);

    const response = await app.inject({
      headers: {
        authorization: 'Bearer sk-not-a-real-key',
        'content-type': 'application/json',
        'x-lightport-custom-host': `http://127.0.0.1:${deadPort}`,
        'x-lightport-provider': 'openai',
      },
      method: 'POST',
      payload: { messages: [{ content: 'hi', role: 'user' }], model: 'gpt-4o' },
      url: '/v1/chat/completions',
    });

    expect(response.statusCode).toBe(500);

    await flush();

    expect(events).toHaveLength(1);
    expect(events[0].tags).toMatchObject({
      adapted: 'false',
      endpoint: 'chatComplete',
      model: 'gpt-4o',
      provider: 'openai',
      stream: 'false',
    });
  });
});
