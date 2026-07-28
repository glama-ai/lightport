import getPort from 'get-port';
import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

const servers: http.Server[] = [];

/**
 * Stands in for a provider. Nothing about the response matters beyond it having
 * arrived: the question these tests ask is whether the request left the gateway
 * at all.
 */
const startProvider = async () => {
  const port = await getPort();

  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ reached: true }));
  });

  servers.push(server);

  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', resolve);
  });

  return `http://127.0.0.1:${port}`;
};

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();

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

describe('externalServiceFetch', () => {
  it('reaches the provider when no dispatcher is configured', async () => {
    const { externalServiceFetch } = await import('../fetch');

    const response = await externalServiceFetch(await startProvider());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ reached: true });
  });

  it('reaches the provider through a configured dispatcher', async () => {
    // `REQUEST_TIMEOUT` is one of the three settings — TLS and a proxy URL being
    // the others — that make `buildAgents` construct an undici dispatcher, and a
    // dispatcher is only usable by the same copy of undici that built it. Hand
    // it to Node's built-in fetch instead and every provider call dies with
    // `invalid onRequestStart method` before a socket is ever opened, which is
    // indistinguishable, from the outside, from the gateway being down.
    //
    // The environment is read when its module first loads, so the reset has to
    // come before the imports rather than after.
    vi.resetModules();
    vi.stubEnv('REQUEST_TIMEOUT', '30000');

    const { buildAgents } = await import('../../agentStore');
    const { externalServiceFetch } = await import('../fetch');

    buildAgents({});

    const response = await externalServiceFetch(await startProvider());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ reached: true });
  });
});
