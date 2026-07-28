import createApp from '../index';
import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

const apps: Array<ReturnType<typeof createApp>> = [];
const servers: http.Server[] = [];

const PROVIDER_THINKING_MS = 300;

/**
 * A provider that is quick to accept a connection and slow to answer, so the
 * time has an unambiguous home: all of it belongs to `ttfb` and none of it to
 * `socket`.
 */
const startProvider = async () => {
  const server = http.createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      setTimeout(() => {
        const payload = JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          created: 1,
          model: 'deepseek-chat',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });

        response.writeHead(200, {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        });
        response.end(payload);
      }, PROVIDER_THINKING_MS);
    });
  });

  servers.push(server);

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
};

const post = async (customHost: string) => {
  const app = createApp();
  apps.push(app);

  return app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: {
      'content-type': 'application/json',
      'x-lightport-provider': 'deepseek',
      'x-lightport-custom-host': customHost,
      'x-lightport-trace-id': 'trace-under-test',
      authorization: 'Bearer test',
    },
    payload: { model: 'deepseek-chat', messages: [{ role: 'user', content: 'ping' }] },
  });
};

const parseServerTiming = (header: string): Record<string, number> => {
  return Object.fromEntries(
    header.split(',').map((metric) => {
      const [name, ...rest] = metric.trim().split(';');
      const duration = rest.find((part) => part.startsWith('dur='));
      return [name, Number(duration?.slice('dur='.length))];
    }),
  );
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

describe('request timing', () => {
  it('reports the stages a request spent its time in', async () => {
    const response = await post(await startProvider());

    expect(response.statusCode).toBe(200);

    const stages = parseServerTiming(response.headers['server-timing'] as string);

    // Time the provider spent thinking has to land on the provider, and not on
    // acquiring the socket: telling a slow gateway from a slow provider is the
    // only reason any of this exists.
    expect(stages.ttfb).toBeGreaterThanOrEqual(PROVIDER_THINKING_MS * 0.8);
    expect(stages.socket).toBeLessThan(PROVIDER_THINKING_MS / 2);
    expect(stages.total).toBeGreaterThanOrEqual(stages.ttfb);
  });

  it('identifies the response so a caller can tie it back to the request', async () => {
    const response = await post(await startProvider());

    expect(response.headers['x-lightport-trace-id']).toBe('trace-under-test');
    expect(response.headers['x-lightport-provider']).toBe('deepseek');
  });
});
