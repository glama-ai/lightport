import * as responsesStreamTransform from '../adapters/responses/streamTransform';
import createApp from '../index';
import getPort from 'get-port';
import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

const apps: Array<ReturnType<typeof createApp>> = [];
const servers: http.Server[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
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

/** A provider streaming chat completion chunks, killed or finished on demand. */
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
          id: 'chat-1',
          model: 'a-model',
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
      state.response?.write('data: [DONE]\n\n');
      state.response?.end();
    },
    /** The provider reports its own mid-stream failure, as most of them do. */
    reportError: () => {
      clearInterval(state.timer);
      state.response?.write(
        `data: ${JSON.stringify({
          error: { message: 'upstream exploded', type: 'server_error' },
        })}\n\n`,
      );
    },
    truncate: () => {
      clearInterval(state.timer);
      state.socket?.destroy();
    },
  };
};

/** Every SSE frame in a body, in order, as a client would dispatch them. */
const parseEvents = (body: string): Array<{ data: any; name: string }> =>
  body
    .split('\n\n')
    .map((block) => block.split('\n').filter(Boolean))
    .filter((lines) => lines.some((line) => line.startsWith('event: ')))
    .map((lines) => ({
      data: JSON.parse(lines.find((line) => line.startsWith('data: '))!.slice('data: '.length)),
      name: lines.find((line) => line.startsWith('event: '))!.slice('event: '.length),
    }));

/**
 * Finds a well-formed `error` event in an SSE body.
 *
 * Parsed the way a client parses it, so a notice merged into the half-written
 * frame ahead of it — the one shape a caller cannot act on — does not count as
 * having arrived.
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

const collect = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onChunk?: (text: string) => void,
): Promise<{ body: string; failed: boolean }> => {
  const decoder = new TextDecoder();
  let body = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return { body, failed: false };

      const text = decoder.decode(value, { stream: true });

      body += text;
      onChunk?.(text);
    }
  } catch {
    return { body, failed: true };
  }
};

/**
 * `deepinfra` is not in the Responses API's native list, so this route is served
 * by the adapter — the path that re-frames a chatComplete stream on its way out.
 * `openai` is native, and reaches the caller without any adapter state behind
 * it, which is the comparison the notice hinges on.
 */
const callGateway = async (providerPort: number, provider = 'deepinfra') => {
  const gatewayPort = await getPort();
  const app = createApp();
  apps.push(app);
  await app.listen({ host: '127.0.0.1', port: gatewayPort });

  return fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
    body: JSON.stringify({ input: 'hi', model: 'a-model', stream: true }),
    headers: {
      authorization: 'Bearer sk-not-a-real-key',
      'content-type': 'application/json',
      'x-lightport-custom-host': `http://127.0.0.1:${providerPort}`,
      'x-lightport-provider': provider,
    },
    method: 'POST',
  });
};

/**
 * The whole body of a stream cut off after it had started, first chunk kept.
 *
 * The events before the failure are half the point — a terminal event is only
 * terminal relative to what it follows, and its sequence and response id have to
 * line up with them.
 */
const truncatedBody = async (provider = 'deepinfra') => {
  const streamProvider = await startProvider();
  const response = await callGateway(streamProvider.port, provider);
  const reader = response.body!.getReader();

  const first = await reader.read();
  const opening = new TextDecoder().decode(first.value);

  // Reading is kept going across the truncation, as a client does. Collecting
  // only once the connection is already gone loses the tail — and the tail is
  // the notice under test: `destroy()` on a socket carrying unread inbound data
  // sends RST, and a peer may drop its receive buffer on one.
  const rest = collect(reader);

  streamProvider.truncate();

  const collected = await rest;

  return { body: opening + collected.body, failed: collected.failed };
};

describe('truncation on the adapter path', () => {
  it('does not hand an adapted caller a truncated stream framed as a finished one', async () => {
    const provider = await startProvider();
    const response = await callGateway(provider.port);

    expect(response.status).toBe(200);

    const reader = response.body!.getReader();
    const first = await reader.read();

    // Proves the adapter is on the path rather than a native passthrough: these
    // events exist only because the chatComplete stream was re-framed. Without
    // this the test would keep passing if `deepinfra` ever became native, having
    // quietly stopped covering the path it is named for — handleStreamingMode
    // fails a truncated stream on its own and would satisfy the rest.
    expect(new TextDecoder().decode(first.value)).toContain('response.created');

    provider.truncate();

    const { body, failed } = await collect(reader);

    // The adapter used to close its writer from a `finally`, so a stream that
    // died mid-completion ended exactly as one that finished — the caller was
    // handed a well-formed, complete-looking response and told the model had
    // answered. Nothing above this layer could tell the difference.
    expect(failed).toBe(true);

    // `announceTruncation` awaits the write callback before the socket is
    // destroyed, so the frame is not a race — and on this route it has to be
    // the Responses one, since a chat-completions envelope reaches a client
    // dispatching on `type` as an event with no type at all.
    expect(findErrorEvent(body)).toMatchObject({ code: 'stream_truncated', type: 'error' });

    // Nothing announced the response as completed on the way out.
    expect(body).not.toContain('response.completed');
  }, 20_000);

  it('still delivers an intact adapted stream cleanly', async () => {
    // The guard against overcorrecting, and the one the adapter path lacked:
    // aborting where the writer should close would fail every stream, and the
    // truncation test above would go on passing. Only the non-adapter path had
    // a success case pinning that.
    const provider = await startProvider();
    const response = await callGateway(provider.port);

    const reader = response.body!.getReader();
    const first = await reader.read();

    expect(new TextDecoder().decode(first.value)).toContain('response.created');

    provider.finish();

    const { body, failed } = await collect(reader);

    expect(failed).toBe(false);
    expect(findErrorEvent(body)).toBeUndefined();
    expect(body).toContain('response.completed');
    expect(body).not.toContain('response.failed');
  }, 20_000);
});

/**
 * A truncated stream is still a stream the caller was following, and the
 * Responses API is a lifecycle: `response.created` opens it and exactly one
 * terminal event closes it. Left with deltas and a bare error, a client
 * following that lifecycle has been told something went wrong and never told
 * the response is over — so it waits, which is the failure the error frame was
 * supposed to end.
 *
 * The send layer cannot write that terminal event: it knows the route and
 * nothing else. These cover the notice the adapter leaves behind for it.
 */
describe('the ending given to a truncated adapted stream', () => {
  it('closes the lifecycle it opened', async () => {
    const { body } = await truncatedBody();
    const names = parseEvents(body).map((event) => event.name);

    expect(names).toContain('response.created');
    expect(names.at(-1)).toBe('response.failed');
  }, 20_000);

  it('gives the response exactly one ending', async () => {
    const { body } = await truncatedBody();
    const names = parseEvents(body).map((event) => event.name);

    // Two terminal events on one response id leave a client no way to order
    // them, and a `completed` among them contradicts the failure outright.
    expect(names.filter((name) => name === 'response.failed')).toHaveLength(1);
    expect(names).not.toContain('response.completed');
    expect(names.filter((name) => name === 'error')).toHaveLength(1);
  }, 20_000);

  it('says on the terminal event what went wrong', async () => {
    const { body } = await truncatedBody();
    const failed = parseEvents(body).find((event) => event.name === 'response.failed')!;

    // `response.failed` is the natural thing for a lifecycle client to read. A
    // status of `failed` with `error: null` beside it reports a failure without
    // saying what it was.
    expect(failed.data.response.status).toBe('failed');
    expect(failed.data.response.error).toMatchObject({
      code: 'stream_truncated',
      message: expect.stringContaining('ended before it was complete'),
    });
  }, 20_000);

  it('ends the response it actually opened', async () => {
    const { body } = await truncatedBody();
    const events = parseEvents(body);
    const created = events.find((event) => event.name === 'response.created')!;
    const failed = events.find((event) => event.name === 'response.failed')!;

    // The whole reason this cannot be written from the send layer: the id is
    // minted in adapter state that never reaches it.
    expect(failed.data.response.id).toBe(created.data.response.id);
    expect(created.data.response.id).toMatch(/\S/);
  }, 20_000);

  it('numbers the ending after the events it follows', async () => {
    const { body } = await truncatedBody();
    const events = parseEvents(body);

    // Asserted on every event, not on whatever happens to carry a number.
    // Filtering first would let the ending drop out of the check entirely and
    // still pass on the events that preceded it — which is exactly the state
    // this test exists to rule out.
    const numbers = events.map((event) => event.data.sequence_number);

    // The other half of what the send layer cannot know. A client tracking the
    // sequence treats a gap as a dropped event and a restart as a new stream.
    expect(numbers).toEqual(events.map((_, index) => index));
    expect(events.at(-1)!.name).toBe('response.failed');
  }, 20_000);

  it('does not present what arrived before the failure as a finished answer', async () => {
    const { body } = await truncatedBody();
    const failed = parseEvents(body).find((event) => event.name === 'response.failed')!;

    // Whatever was salvaged is half-written by definition. Reported `completed`
    // it reads as the model's answer — and a tool call's truncated arguments as
    // JSON a caller is invited to parse.
    for (const item of failed.data.response.output) {
      expect(item.status).not.toBe('completed');
    }
  }, 20_000);

  it('leaves an upstream that already failed with the ending it gave itself', async () => {
    // `cerebras` registers no stream transform, so an OpenAI-compatible
    // upstream's own error frame reaches the adapter as written — the common
    // case, since most of the catalogue registers none.
    const streamProvider = await startProvider();
    const response = await callGateway(streamProvider.port, 'cerebras');
    const reader = response.body!.getReader();

    const opening = new TextDecoder().decode((await reader.read()).value);

    // Read continuously from here, as a client does. Collecting only after the
    // connection is gone loses the tail: `destroy()` on a socket with unread
    // inbound data sends RST, and a peer is free to drop its receive buffer.
    let seen = '';
    const rest = collect(reader, (text) => {
      seen += text;
    });

    // The provider reports its own failure and only then drops the connection —
    // the ordinary shape of an outage. The response has been given an ending,
    // and a second one behind it would contradict the first.
    streamProvider.reportError();

    // Waited for rather than slept through. A fixed pause is the only thing
    // ordering these two events, and on a loaded runner the socket can die
    // first — at which point the failure under test never reaches the adapter,
    // the truncation notice fires instead, and the test flips for a reason that
    // has nothing to do with the code.
    await vi.waitFor(() => expect(seen).toContain('upstream exploded'), { timeout: 10_000 });

    streamProvider.truncate();

    const body = opening + (await rest).body;
    const names = parseEvents(body).map((event) => event.name);

    expect(names.filter((name) => name === 'response.failed')).toHaveLength(1);
    expect(names.filter((name) => name === 'error')).toHaveLength(1);
    expect(body).toContain('upstream exploded');
    expect(body).not.toContain('stream_truncated');
  }, 20_000);

  it('still hangs up when composing the ending throws', async () => {
    // Composing the notice is no longer the constant lookup it replaced: it
    // runs a transform over everything the stream accumulated. If that throws
    // and the throw escapes, `raw.destroy()` never runs and the caller is left
    // holding an open socket with neither a terminating chunk nor a close —
    // waiting out a server timeout to learn nothing, which is strictly worse
    // than the silence this whole mechanism replaced. Fastify cannot report it
    // either: the reply was hijacked, so the rejection is dropped unlogged.
    const real = responsesStreamTransform.transformStreamChunk;

    vi.spyOn(responsesStreamTransform, 'transformStreamChunk').mockImplementation(
      (chunk, state) => {
        if (chunk.includes('stream_truncated')) {
          throw new Error('composing the ending blew up');
        }

        return real(chunk, state);
      },
    );

    const streamProvider = await startProvider();
    const response = await callGateway(streamProvider.port);
    const reader = response.body!.getReader();

    await reader.read();

    const rest = collect(reader);

    streamProvider.truncate();

    // The assertion is that this resolves at all. Before the guard it hung
    // until the test timed out.
    const { failed } = await rest;

    expect(failed).toBe(true);
  }, 20_000);

  it('leaves a native provider the frame its route implies and no more', async () => {
    // `openai` serves Responses itself, so there is no adapter state and no
    // notice. The sequence is the provider's own to number, and inventing a
    // terminal event for it would be inventing a number too.
    const { body } = await truncatedBody('openai');
    const names = parseEvents(body).map((event) => event.name);

    expect(names).toContain('error');
    expect(names).not.toContain('response.failed');
    expect(findErrorEvent(body)).toMatchObject({ code: 'stream_truncated', type: 'error' });
  }, 20_000);
});
