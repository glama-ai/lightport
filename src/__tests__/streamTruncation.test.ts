import createApp from '../index';
import { logger } from '../logger';
import type { ErrorEvent } from '@sentry/core';
import * as Sentry from '@sentry/node-core/light';
import getPort from 'get-port';
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const events: ErrorEvent[] = [];
const apps: Array<ReturnType<typeof createApp>> = [];
const servers: http.Server[] = [];

/**
 * The per-request log lines.
 *
 * Sentry is not the record that matters most here. Every truncation the gateway
 * reports carries the same relabelled message, so they share one bucket in the
 * event rate limiter — during the provider outage that produces them by the
 * hundred, most are dropped and this line is the only complete account left.
 */
const requestLogs: Array<Record<string, unknown>> = [];

beforeAll(() => {
  vi.spyOn(logger, 'info').mockImplementation(((
    entry: Record<string, unknown>,
    message: string,
  ) => {
    if (message === 'request complete') {
      requestLogs.push(entry);
    }

    return logger;
  }) as never);

  Sentry.init({
    beforeSend: (event) => {
      events.push(event);
      return null;
    },
    dsn: 'https://public@example.invalid/1',
  });
});

// Restored rather than left in place: the spy silences every info log for the
// rest of the file, and vitest's per-file isolation is the only thing keeping
// that from leaking further.
afterAll(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  events.length = 0;
  requestLogs.length = 0;
});

/** The log line for the request just served, once it has been written. */
const lastRequestLog = async () => {
  await vi.waitFor(() => expect(requestLogs.length).toBeGreaterThan(0), { timeout: 5_000 });

  return requestLogs.at(-1)!;
};

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
const startProvider = async ({ chunkPadding = 0 }: { chunkPadding?: number } = {}) => {
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
          choices: [{ delta: { content: `tok-${sent}${'.'.repeat(chunkPadding)}` }, index: 0 }],
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

/**
 * A provider streaming something the gateway never framed, which the test cuts
 * off mid-body.
 *
 * Audio, an image, a file download: bytes with no notion of an event, where the
 * notice a truncated SSE stream gets would be 200 bytes of JSON spliced into
 * the middle of the very thing the caller is trying to salvage.
 */
const startBinaryProvider = async () => {
  const state: { socket?: import('node:net').Socket; timer?: NodeJS.Timeout } = {};

  const server = http.createServer((request, response) => {
    state.socket = request.socket;
    response.writeHead(200, { 'content-type': 'audio/mpeg' });

    state.timer = setInterval(() => response.write(Buffer.alloc(1_024, 0x41)), 10);
    request.on('close', () => clearInterval(state.timer));
  });

  servers.push(server);

  const port = await getPort();
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));

  return {
    port,
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

const startGateway = async () => {
  const gatewayPort = await getPort();
  const app = createApp();
  apps.push(app);
  await app.listen({ host: '127.0.0.1', port: gatewayPort });

  return gatewayPort;
};

const callGateway = async (providerPort: number, path = '/v1/chat/completions', stream = true) => {
  const gatewayPort = await startGateway();

  return fetch(`http://127.0.0.1:${gatewayPort}${path}`, {
    body: JSON.stringify({
      ...(path === '/v1/responses'
        ? { input: 'hi' }
        : { messages: [{ content: 'hi', role: 'user' }] }),
      model: 'gpt-4o',
      stream,
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

    // The status was written when the headers went out and says 200, so without
    // this the request that failed a waiting caller looks like every request
    // that did not.
    const truncation = events.find(
      (event) => event.exception?.values?.at(-1)?.value === 'response stream truncated',
    );

    expect(truncation?.tags?.truncated).toBe('true');

    // The line the operator actually has during an outage. `status` says 200
    // because it was written when the headers went out, so on its own it makes
    // a request that failed its caller indistinguishable from one that did not.
    expect(await lastRequestLog()).toMatchObject({ status: 200, truncated: true });
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

    expect(await lastRequestLog()).not.toHaveProperty('truncated');
  }, 20_000);

  it('appends nothing to a stream the gateway never framed', async () => {
    // The highest-consequence line in the whole change. Audio, an image, a file
    // download: the notice would be spliced into the middle of the bytes the
    // caller is trying to salvage, corrupting the one thing left to recover.
    const provider = await startBinaryProvider();
    const response = await callGateway(provider.port, '/v1/chat/completions', false);

    expect(response.headers.get('content-type')).toContain('audio/mpeg');

    const reader = response.body!.getReader();

    await reader.read();
    provider.truncate();

    const { body, failed } = await collect(reader);

    // The hangup still reports it. Only the in-band frame is withheld, because
    // this is a body with no vocabulary to say it in.
    expect(failed).toBe(true);
    expect(body).not.toContain('stream_truncated');
    expect(body).toMatch(/^A*$/);
  }, 20_000);

  it('names the truncation in the vocabulary of the API that was asked for', async () => {
    // Both routes serve text/event-stream, but Responses frames an error flat
    // and names the event in the payload. Sent the chat-completions envelope, a
    // client dispatching on `type` finds no `type` field and passes over the one
    // frame explaining the stream it is about to lose.
    const provider = await startProvider();
    const response = await callGateway(provider.port, '/v1/responses');
    const reader = response.body!.getReader();

    await reader.read();
    provider.truncate();

    const { body } = await collect(reader);
    const raised = findErrorEvent(body);

    expect(raised).toMatchObject({ code: 'stream_truncated', type: 'error' });
    expect(raised).not.toHaveProperty('error');
  }, 20_000);

  it('tells a caller who gave up apart from one who was served', async () => {
    const provider = await startProvider();
    const response = await callGateway(provider.port);
    const reader = response.body!.getReader();

    await reader.read();

    // The caller walks away mid-stream. Nobody was failed, so this is not a
    // truncation — but it is not a delivery either, and after the headers have
    // gone out the status can no longer tell the two apart.
    await reader.cancel();

    const log = await lastRequestLog();

    expect(log).toMatchObject({ disconnected: true });
    expect(log).not.toHaveProperty('truncated');

    await Sentry.flush(2_000);

    // Nobody was failed, so nobody should be paged. A hangup filed as a
    // truncation would wake someone for a closed tab.
    expect(events.map((event) => event.exception?.values?.at(-1)?.value)).not.toContain(
      'response stream truncated',
    );
  }, 20_000);

  it('tells apart a caller who gave up while the socket was full', async () => {
    // The exit the accounting used to miss. A caller that stops reading fills
    // the socket buffer and parks the pump on `drain` — so it leaves by a path
    // that never throws, and the request was logged as an ordinary delivered
    // 200. It is also the likeliest way to leave: a caller that reads one chunk
    // of sixty and walks away is exactly a caller too slow to keep up.
    const provider = await startProvider({ chunkPadding: 128 * 1024 });
    const gatewayPort = await startGateway();

    // A raw socket, never read from, so the kernel buffers fill and stay full.
    // `fetch` would drain them on the caller's behalf and the pump would never
    // park.
    const socket = net.connect(gatewayPort, '127.0.0.1');
    await once(socket, 'connect');
    socket.pause();

    const body = JSON.stringify({
      messages: [{ content: 'hi', role: 'user' }],
      model: 'gpt-4o',
      stream: true,
    });

    socket.write(
      `POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1\r\n` +
        `authorization: Bearer sk-not-a-real-key\r\ncontent-type: application/json\r\n` +
        `x-lightport-custom-host: http://127.0.0.1:${provider.port}\r\n` +
        `x-lightport-provider: openai\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );

    // Long enough for the gateway's headers to go out and the pump to back up
    // against a peer that is not reading.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    socket.destroy();

    const log = await lastRequestLog();

    expect(log).toMatchObject({ disconnected: true });
    expect(log).not.toHaveProperty('truncated');
  }, 20_000);
});
