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

/**
 * An OpenAI-compatible upstream that sends a token, then fails mid-stream, then
 * ends the response cleanly — which is what a provider does when it rejects a
 * request it had already begun answering. Nothing is truncated here: the only
 * account of the failure is the frame itself.
 */
const startProvider = async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(
      `data: ${JSON.stringify({
        id: 'c1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'a-model',
        choices: [{ index: 0, delta: { content: 'Hel' }, finish_reason: null }],
      })}\n\n`,
    );
    response.write(
      `data: ${JSON.stringify({
        error: { message: 'rate limit exceeded', type: 'rate_limit_error' },
      })}\n\n`,
    );
    response.end();
  });

  servers.push(server);

  const port = await getPort();
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));

  return port;
};

const streamFrom = async (provider: string) => {
  const providerPort = await startProvider();
  const gatewayPort = await getPort();
  const app = createApp();
  apps.push(app);
  await app.listen({ host: '127.0.0.1', port: gatewayPort });

  const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
    body: JSON.stringify({
      messages: [{ content: 'hi', role: 'user' }],
      model: 'a-model',
      stream: true,
    }),
    headers: {
      authorization: 'Bearer sk-not-a-real-key',
      'content-type': 'application/json',
      'x-lightport-custom-host': `http://127.0.0.1:${providerPort}`,
      'x-lightport-provider': provider,
    },
    method: 'POST',
  });

  return await response.text();
};

/**
 * The failure a provider reports mid-stream has to reach the caller as a
 * failure. Two ways it used to be lost, and they need different answers.
 */
describe('an upstream failure reported mid-stream', () => {
  it('survives a provider transform that throws on it', async () => {
    // `deepinfra` reaches for `choices[0]` unguarded, so the error frame threw
    // and took the stream down. The caller was told the connection broke — back
    // off and retry — when it should have been told the request was refused.
    const body = await streamFrom('deepinfra');

    expect(body).toContain('rate limit exceeded');
    expect(body).toContain('rate_limit_error');
  }, 20_000);

  it('survives a provider transform that quietly drops it', async () => {
    // `groq` answered the error frame with `{"choices":[]}`. Nothing threw and
    // nothing was truncated, so the stream ran to its end and the caller read a
    // model that had finished and chosen to say nothing — the one result it
    // cannot check.
    const body = await streamFrom('groq');

    expect(body).toContain('rate limit exceeded');
    expect(body).toContain('rate_limit_error');
  }, 20_000);

  it('is named as the provider that raised it', async () => {
    // The same prefix `generateErrorResponse` puts on a non-streamed failure, so
    // an error reads the same whether or not the caller asked for a stream.
    const body = await streamFrom('deepinfra');

    expect(body).toContain('deepinfra error: rate limit exceeded');
  }, 20_000);

  it('leaves a healthy stream untouched', async () => {
    // The overcorrection guard at the level that matters: a stream carrying no
    // failure must reach the caller with none added.
    const providerPort = await getPort();
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(
        `data: ${JSON.stringify({
          id: 'c1',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'a-model',
          choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }],
        })}\n\n`,
      );
      response.write('data: [DONE]\n\n');
      response.end();
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(providerPort, '127.0.0.1', resolve));

    const gatewayPort = await getPort();
    const app = createApp();
    apps.push(app);
    await app.listen({ host: '127.0.0.1', port: gatewayPort });

    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      body: JSON.stringify({
        messages: [{ content: 'hi', role: 'user' }],
        model: 'a-model',
        stream: true,
      }),
      headers: {
        authorization: 'Bearer sk-not-a-real-key',
        'content-type': 'application/json',
        'x-lightport-custom-host': `http://127.0.0.1:${providerPort}`,
        'x-lightport-provider': 'deepinfra',
      },
      method: 'POST',
    });

    const body = await response.text();

    expect(body).toContain('hi');
    expect(body).not.toContain('event: error');
    expect(body).toContain('[DONE]');
  }, 20_000);
});
