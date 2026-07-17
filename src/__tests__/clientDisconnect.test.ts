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

const CHUNK_INTERVAL_MS = 20;
const TOTAL_CHUNKS = 60;

/**
 * Stands in for a provider streaming a long completion. Reports how much it got
 * to send and whether the gateway ever hung up, which is the whole question: a
 * provider is billing for every token it generates, so a gateway that keeps
 * reading after its own caller has gone is burning the operator's money.
 */
const startSlowProvider = async () => {
  const state = { chunksSent: 0, sawGatewayHangUp: false };

  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });

    const timer = setInterval(() => {
      if (state.chunksSent >= TOTAL_CHUNKS) {
        clearInterval(timer);
        response.end();
        return;
      }

      state.chunksSent++;
      response.write(
        `data: ${JSON.stringify({
          choices: [{ delta: { content: `tok-${state.chunksSent}` }, index: 0 }],
        })}\n\n`,
      );
    }, CHUNK_INTERVAL_MS);

    request.on('close', () => {
      clearInterval(timer);
      state.sawGatewayHangUp = true;
    });
  });

  servers.push(server);

  const port = await getPort();
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));

  return { port, state };
};

describe('client disconnect', () => {
  it('stops reading the provider once the caller has gone', async () => {
    const provider = await startSlowProvider();
    const gatewayPort = await getPort();
    const app = createApp();
    apps.push(app);
    await app.listen({ host: '127.0.0.1', port: gatewayPort });

    const caller = new AbortController();

    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      body: JSON.stringify({
        messages: [{ content: 'hi', role: 'user' }],
        model: 'gpt-4o',
        stream: true,
      }),
      headers: {
        authorization: 'Bearer sk-not-a-real-key',
        'content-type': 'application/json',
        'x-lightport-custom-host': `http://127.0.0.1:${provider.port}`,
        'x-lightport-provider': 'openai',
      },
      method: 'POST',
      signal: caller.signal,
    });

    expect(response.status).toBe(200);

    // Take one chunk to prove the stream is live, then vanish the way a real
    // caller does: destroy the socket without a word.
    const reader = response.body!.getReader();
    await reader.read();

    const sentWhenCallerLeft = provider.state.chunksSent;
    caller.abort();

    // Long enough that the provider would have finished the whole completion.
    await new Promise((resolve) => setTimeout(resolve, CHUNK_INTERVAL_MS * TOTAL_CHUNKS));

    expect(provider.state.sawGatewayHangUp).toBe(true);
    expect(provider.state.chunksSent).toBeLessThan(TOTAL_CHUNKS);
    // A couple more may land in the gap between the socket dying and the abort
    // propagating; a leak would instead run the completion out to TOTAL_CHUNKS.
    expect(provider.state.chunksSent - sentWhenCallerLeft).toBeLessThan(10);
  }, 20_000);

  it('still reports a provider timeout as a timeout, not a disconnect', async () => {
    // The caller's abort signal now shares a fetch with the timeout's, so the
    // two have to stay distinguishable. Note requestTimeout only bounds
    // time-to-headers, so this provider withholds them rather than being merely
    // slow to finish.
    const silent = http.createServer(() => {
      // Never responds.
    });
    servers.push(silent);
    const silentPort = await getPort();
    await new Promise<void>((resolve) => silent.listen(silentPort, '127.0.0.1', resolve));

    const gatewayPort = await getPort();
    const app = createApp();
    apps.push(app);
    await app.listen({ host: '127.0.0.1', port: gatewayPort });

    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      body: JSON.stringify({ messages: [{ content: 'hi', role: 'user' }], model: 'gpt-4o' }),
      headers: {
        authorization: 'Bearer sk-not-a-real-key',
        'content-type': 'application/json',
        'x-lightport-custom-host': `http://127.0.0.1:${silentPort}`,
        'x-lightport-provider': 'openai',
        'x-lightport-request-timeout': '40',
      },
      method: 'POST',
    });

    expect(response.status).toBe(408);
    expect(await response.json()).toMatchObject({
      error: { type: 'timeout_error' },
    });
  }, 20_000);

  it('still streams a full response through to a caller that stays', async () => {
    const provider = await startSlowProvider();
    const gatewayPort = await getPort();
    const app = createApp();
    apps.push(app);
    await app.listen({ host: '127.0.0.1', port: gatewayPort });

    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      body: JSON.stringify({
        messages: [{ content: 'hi', role: 'user' }],
        model: 'gpt-4o',
        stream: true,
      }),
      headers: {
        authorization: 'Bearer sk-not-a-real-key',
        'content-type': 'application/json',
        'x-lightport-custom-host': `http://127.0.0.1:${provider.port}`,
        'x-lightport-provider': 'openai',
      },
      method: 'POST',
    });

    expect(response.status).toBe(200);

    const body = await response.text();

    // The abort plumbing must not truncate a caller who is still listening.
    expect(provider.state.chunksSent).toBe(TOTAL_CHUNKS);
    expect(body).toContain(`tok-${TOTAL_CHUNKS}`);
    expect(provider.state.sawGatewayHangUp).toBe(true);
  }, 20_000);
});
