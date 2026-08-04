import createApp from '../index';
import type { ErrorEvent } from '@sentry/core';
import * as Sentry from '@sentry/node-core/light';
import getPort from 'get-port';
import http from 'node:http';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const events: ErrorEvent[] = [];
const apps: Array<ReturnType<typeof createApp>> = [];
const servers: http.Server[] = [];

beforeAll(() => {
  Sentry.init({
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
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

/**
 * A provider streaming a completion, which the test ends on its own terms —
 * either dropping the connection the way an upstream reset does, or finishing
 * properly.
 *
 * The timing is driven rather than raced: the gateway holds its first chunk back
 * by 25ms (streamHandler's readStream), so a provider that dies on a timer can
 * beat the gateway's headers onto the wire and leave the caller with a bare
 * connection error. That is also detectable, but it is not the case under test —
 * the point here is a 200 that has already been committed.
 */
const startProvider = async () => {
  const state: {
    response?: http.ServerResponse;
    socket?: import('node:net').Socket;
    timer?: NodeJS.Timeout;
  } = {};

  const server = http.createServer((request, response) => {
    state.response = response;
    state.socket = request.socket;
    response.writeHead(200, { 'content-type': 'text/event-stream' });

    let sent = 0;
    state.timer = setInterval(() => {
      sent++;
      response.write(
        `data: ${JSON.stringify({
          choices: [{ delta: { content: `tok-${sent}` }, index: 0 }],
        })}\n\n`,
      );
    }, 10);

    request.on('close', () => clearInterval(state.timer));
  });

  servers.push(server);

  const port = await getPort();
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));

  return {
    port,
    /** The provider finishes the completion properly. */
    finish: () => {
      clearInterval(state.timer);
      state.response?.end();
    },
    /** The provider's connection drops mid-completion. */
    truncate: () => {
      clearInterval(state.timer);
      state.socket?.destroy();
    },
  };
};

/** Drains a reader to completion, surfacing whatever the stream errors with. */
const drain = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
  while (true) {
    const { done } = await reader.read();
    if (done) return;
  }
};

/**
 * Finds a well-formed `error` event in an SSE body.
 *
 * Searching for the text would also match it merged into a half-written frame
 * ahead of it, which is the one shape a caller cannot act on. What has to hold
 * is that the notice arrives as an event in its own right, so this parses the
 * body the way a client does and returns only what a client would recover.
 */
const findErrorEvent = (body: string): Record<string, any> | undefined => {
  for (const block of body.split('\n\n')) {
    const lines = block.split('\n').filter((line) => line !== '');

    if (!lines.includes('event: error')) {
      continue;
    }

    const data = lines.find((line) => line.startsWith('data: '));

    if (data) {
      return JSON.parse(data.slice('data: '.length));
    }
  }

  return undefined;
};

/**
 * Drains a reader keeping what arrived, and reports how it ended rather than
 * throwing — what a caller was left holding is the thing under test here.
 */
const collect = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<{ body: string; failed: boolean }> => {
  const decoder = new TextDecoder();
  let body = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return { body, failed: false };
      body += decoder.decode(value, { stream: true });
    }
  } catch {
    return { body, failed: true };
  }
};

const callGateway = async (providerPort: number) => {
  const gatewayPort = await getPort();
  const app = createApp();
  apps.push(app);
  await app.listen({ host: '127.0.0.1', port: gatewayPort });

  return fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
    body: JSON.stringify({
      messages: [{ content: 'hi', role: 'user' }],
      model: 'gpt-4o',
      stream: true,
    }),
    headers: {
      authorization: 'Bearer sk-not-a-real-key',
      'content-type': 'application/json',
      'x-lightport-custom-host': `http://127.0.0.1:${providerPort}`,
      'x-lightport-provider': 'openai',
    },
    method: 'POST',
  });
};

describe('upstream stream truncation', () => {
  it('does not hand the caller a truncated body framed as a complete one', async () => {
    const provider = await startProvider();
    const response = await callGateway(provider.port);

    expect(response.status).toBe(200);

    const reader = response.body!.getReader();

    // Take a chunk before killing the provider, so the 200 and part of the body
    // are provably on the wire. Only then can the gateway no longer revise the
    // status, which is the whole predicament under test.
    const first = await reader.read();

    expect(new TextDecoder().decode(first.value)).toContain('tok-');

    provider.truncate();

    // Draining the rest has to fail. If it ends cleanly the gateway has written
    // the terminating chunk over a half-finished completion, and the caller has
    // no way of knowing the tokens simply stop early.
    await expect(drain(reader)).rejects.toThrow();
  }, 20_000);

  it('names the truncation in the body, the one channel it has left', async () => {
    const provider = await startProvider();
    const response = await callGateway(provider.port);
    const reader = response.body!.getReader();

    await reader.read();
    provider.truncate();

    const { body, failed } = await collect(reader);

    expect(failed).toBe(true);

    // The hangup asserted above stops being legible at the first intermediary
    // that buffers this body and serves it on, and one that has buffered a body
    // ends it cleanly — which is how a truncated stream becomes an empty
    // completion somebody trusts. This is the part of the signal that travels
    // with the payload instead, and it has to arrive parseable, not merely
    // present.
    expect(findErrorEvent(body)?.error).toMatchObject({
      code: 'stream_truncated',
      type: 'server_error',
    });
  }, 20_000);

  it('reports a truncation the caller was made to suffer', async () => {
    const provider = await startProvider();
    const response = await callGateway(provider.port);
    const reader = response.body!.getReader();

    await reader.read();
    provider.truncate();
    await drain(reader).catch(() => {
      // Expected; asserted above.
    });

    await Sentry.flush(2_000);

    // The last entry is the error captureException actually relabels; index 0
    // is the underlying socket cause, which is left alone so it stays legible.
    const captured = events.map((event) => event.exception?.values?.at(-1)?.value);

    expect(captured).toContain('response stream truncated');
  }, 20_000);

  it('still delivers an intact stream cleanly', async () => {
    const provider = await startProvider();
    const response = await callGateway(provider.port);

    expect(response.status).toBe(200);

    const reader = response.body!.getReader();
    const first = await reader.read();

    expect(new TextDecoder().decode(first.value)).toContain('tok-');

    provider.finish();

    // The guard against overcorrecting: a healthy stream must still terminate
    // normally, report nothing, and carry no error frame.
    const { body, failed } = await collect(reader);

    expect(failed).toBe(false);
    expect(findErrorEvent(body)).toBeUndefined();

    await Sentry.flush(2_000);

    expect(events.map((event) => event.exception?.values?.at(-1)?.value)).not.toContain(
      'response stream truncated',
    );
  }, 20_000);
});
