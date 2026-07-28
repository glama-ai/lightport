import createApp from '../index';
import getPort from 'get-port';
import http from 'node:http';
import { afterEach, expect, it } from 'vitest';

/**
 * The gateway pauses 25ms before the first chunk of an Azure OpenAI stream, and
 * used to do it for every provider. Nothing failed when it did — the tokens all
 * arrived, just later — so only a clock notices.
 *
 * Asserted as the difference between two providers measured back to back rather
 * than as an absolute duration. A machine under load inflates both equally, so
 * the gap holds where a threshold would not: the first version of this timed one
 * request against 25ms and flaked once the rest of the suite ran alongside it.
 *
 * It fails in both directions, which is the point. Pace every provider again and
 * the gap closes; stop pacing Azure and it closes too.
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

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

it('paces Azure OpenAI streams and no others', { retry: 2 }, async () => {
  const providerPort = await startProvider();
  const port = await getPort();
  const app = createApp();
  apps.push(app);
  await app.listen({ host: '127.0.0.1', port });

  const shared = {
    authorization: 'Bearer sk-not-a-real-key',
    'content-type': 'application/json',
    'x-lightport-custom-host': `http://127.0.0.1:${providerPort}/v1`,
  };

  const openai = { ...shared, 'x-lightport-provider': 'openai' };
  const azure = {
    ...shared,
    'x-lightport-provider': 'azure-openai',
    'x-lightport-azure-api-version': '2024-02-01',
    'x-lightport-azure-deployment-id': 'deployment',
    'x-lightport-azure-resource-name': 'resource',
  };

  const timeToFirstChunk = async (headers: Record<string, string>) => {
    const startedAt = performance.now();

    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      body: JSON.stringify({
        messages: [{ content: 'hi', role: 'user' }],
        model: 'gpt-4o-mini',
        stream: true,
      }),
      headers,
      method: 'POST',
    });

    expect(response.status).toBe(200);

    const reader = response.body!.getReader();
    const { value } = await reader.read();
    const elapsed = performance.now() - startedAt;

    await reader.cancel();
    expect(new TextDecoder().decode(value)).toContain('data:');

    return elapsed;
  };

  // Warmed first: a cold route costs more than the pause being measured.
  for (let round = 0; round < 3; round++) {
    await timeToFirstChunk(openai);
    await timeToFirstChunk(azure);
  }

  const unpaced: number[] = [];
  const paced: number[] = [];

  for (let round = 0; round < 5; round++) {
    unpaced.push(await timeToFirstChunk(openai));
    paced.push(await timeToFirstChunk(azure));
  }

  // The pause is 25ms; anything above half of it can only be the pause.
  expect(median(paced) - median(unpaced)).toBeGreaterThan(15);
}, 30_000);
