import createApp from '../index';
import Providers from '../providers';
import { externalServiceFetch } from '../utils/fetch';
import getPort from 'get-port';
import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

const apps: Array<ReturnType<typeof createApp>> = [];
const servers: http.Server[] = [];
const restores: Array<() => void> = [];

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
  restores.splice(0).forEach((restore) => restore());
});

/**
 * Gives a provider a custom request handler for chatComplete, the way bedrock
 * carries one for its file and batch endpoints. The handler reaches the
 * provider through externalServiceFetch, so it inherits whatever ambient abort
 * signal the gateway has wired up - which is the whole question here: a
 * requestTimeout has to reach it, or a call to a wedged provider hangs forever.
 */
const withCustomChatHandler = (provider: string, customHost: string) => {
  const config = (Providers as Record<string, any>)[provider];
  const previous = config.requestHandlers;
  config.requestHandlers = {
    ...previous,
    chatComplete: async () => {
      // No try/catch: an abort surfaces as an AbortError the gateway is meant
      // to map to a timeout, exactly as the non-handler path does.
      return externalServiceFetch(`${customHost}/chat`, { method: 'POST' });
    },
  };
  restores.push(() => {
    config.requestHandlers = previous;
  });
};

describe('custom request handler timeout', () => {
  it('bounds a custom request handler by requestTimeout', async () => {
    // A provider that accepts the connection and then never answers, the shape
    // a file or batch call to a wedged backend takes.
    const silent = http.createServer(() => {
      // Never responds.
    });
    servers.push(silent);
    const silentPort = await getPort();
    await new Promise<void>((resolve) => silent.listen(silentPort, '127.0.0.1', resolve));

    withCustomChatHandler('openai', `http://127.0.0.1:${silentPort}`);

    const gatewayPort = await getPort();
    const app = createApp();
    apps.push(app);
    await app.listen({ host: '127.0.0.1', port: gatewayPort });

    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      body: JSON.stringify({ messages: [{ content: 'hi', role: 'user' }], model: 'gpt-4o' }),
      headers: {
        authorization: 'Bearer sk-not-a-real-key',
        'content-type': 'application/json',
        'x-lightport-provider': 'openai',
        'x-lightport-request-timeout': '40',
      },
      method: 'POST',
    });

    expect(response.status).toBe(408);
    expect(await response.json()).toMatchObject({ error: { type: 'timeout_error' } });
  }, 20_000);
});
