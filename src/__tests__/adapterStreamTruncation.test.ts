import createApp from '../index';
import getPort from 'get-port';
import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

const apps: Array<ReturnType<typeof createApp>> = [];
const servers: http.Server[] = [];

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
    truncate: () => {
      clearInterval(state.timer);
      state.socket?.destroy();
    },
  };
};

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

/**
 * `deepinfra` is not in the Responses API's native list, so this route is served
 * by the adapter — the path that re-frames a chatComplete stream on its way out.
 */
const callGateway = async (providerPort: number) => {
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
      'x-lightport-provider': 'deepinfra',
    },
    method: 'POST',
  });
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
  }, 20_000);
});
