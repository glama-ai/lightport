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

const TOTAL_CHUNKS = 3;

/**
 * A provider whose connection drops partway through a completion — the ordinary
 * shape of an upstream reset. The caller has already been given a 200, so the
 * gateway cannot take it back; the only question is whether it admits the body
 * is incomplete or seals it up as if nothing happened.
 */
const startProvider = async ({ truncate }: { truncate: boolean }) => {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });

    let sent = 0;
    const timer = setInterval(() => {
      if (sent >= TOTAL_CHUNKS) {
        clearInterval(timer);

        if (truncate) {
          request.socket.destroy();
        } else {
          response.end();
        }

        return;
      }

      sent++;
      response.write(
        `data: ${JSON.stringify({
          choices: [{ delta: { content: `tok-${sent}` }, index: 0 }],
        })}\n\n`,
      );
    }, 10);
  });

  servers.push(server);

  const port = await getPort();
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));

  return { port };
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
    const provider = await startProvider({ truncate: true });
    const response = await callGateway(provider.port);

    // The status line went out before the provider died, so 200 is expected and
    // cannot be revised. Everything rests on how the body is terminated.
    expect(response.status).toBe(200);

    // Reading the body has to fail. If it resolves, the gateway has written the
    // terminating chunk over a truncated completion and the caller has no way of
    // knowing the tokens simply stop early.
    await expect(response.text()).rejects.toThrow();
  }, 20_000);

  it('reports a truncation the caller was made to suffer', async () => {
    const provider = await startProvider({ truncate: true });
    const response = await callGateway(provider.port);

    await response.text().catch(() => {
      // Expected; asserted above.
    });
    await Sentry.flush(2_000);

    const captured = events.map((event) => event.exception?.values?.[0]?.value);

    expect(captured).toContain('response stream truncated');
  }, 20_000);

  it('still delivers an intact stream cleanly', async () => {
    const provider = await startProvider({ truncate: false });
    const response = await callGateway(provider.port);

    expect(response.status).toBe(200);

    // The guard against overcorrecting: a healthy stream must still terminate
    // normally and report nothing.
    const body = await response.text();

    expect(body).toContain(`tok-${TOTAL_CHUNKS}`);

    await Sentry.flush(2_000);

    expect(events.map((event) => event.exception?.values?.[0]?.value)).not.toContain(
      'response stream truncated',
    );
  }, 20_000);
});
