import createApp from '../index';
import getPort from 'get-port';
import http from 'node:http';
import { afterEach, expect, it } from 'vitest';

/**
 * The gateway used to pause 25ms before forwarding the first chunk of every
 * stream, whatever the provider. Nothing failed when it did — the tokens all
 * arrived, just later — so only a clock notices.
 */

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

/** Answers with an SSE stream whose first chunk is already on the wire. */
const startProvider = async () => {
  const server = http.createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(
        `data: ${JSON.stringify({
          id: 'chatcmpl-1',
          object: 'chat.completion.chunk',
          created: 1_700_000_000,
          model: 'gpt-4o-mini',
          choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }],
        })}\n\n`,
      );
      response.write('data: [DONE]\n\n');
      response.end();
    });
  });

  servers.push(server);
  const port = await getPort();
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));

  return port;
};

it('forwards the first chunk of a stream without pausing first', async () => {
  const providerPort = await startProvider();
  const port = await getPort();
  const app = createApp();
  apps.push(app);
  await app.listen({ host: '127.0.0.1', port });

  const startedAt = performance.now();

  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    body: JSON.stringify({
      messages: [{ content: 'hi', role: 'user' }],
      model: 'gpt-4o-mini',
      stream: true,
    }),
    headers: {
      authorization: 'Bearer sk-not-a-real-key',
      'content-type': 'application/json',
      'x-lightport-custom-host': `http://127.0.0.1:${providerPort}/v1`,
      'x-lightport-provider': 'openai',
    },
    method: 'POST',
  });

  expect(response.status).toBe(200);

  const reader = response.body!.getReader();
  const { value } = await reader.read();
  const firstChunkMs = performance.now() - startedAt;

  await reader.cancel();

  expect(new TextDecoder().decode(value)).toContain('data:');

  // The pause removed was 25ms, so a regression cannot come in under that.
  // Everything here is in-process over loopback, which leaves enough room that
  // this is measuring the pause rather than the machine.
  expect(firstChunkMs).toBeLessThan(25);
}, 15_000);
