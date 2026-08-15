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

type Received = { body: string | undefined; path: string | undefined };

/**
 * Stands in for whichever provider the request is aimed at, recording what
 * arrived so the request transform can be read off the wire rather than
 * inferred from the config.
 */
const startProvider = async (reply: { body: string; contentType: string; status: number }) => {
  const received: Received = { body: undefined, path: undefined };

  const server = http.createServer((request, response) => {
    received.path = request.url;

    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      // Recorded raw and parsed by the test: throwing in here would take down
      // the worker instead of failing the assertion that wanted to see it.
      received.body = Buffer.concat(chunks).toString();
      response.writeHead(reply.status, { 'content-type': reply.contentType });
      response.end(reply.body);
    });
  });

  servers.push(server);

  const port = await getPort();
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));

  return { port, received };
};

const generateRaw = async (
  provider: string,
  body: Record<string, unknown>,
  providerPort?: number,
) => {
  const app = createApp();
  apps.push(app);

  const response = await app.inject({
    headers: {
      authorization: 'Bearer sk-not-a-real-key',
      'content-type': 'application/json',
      'x-lightport-provider': provider,
      ...(providerPort ? { 'x-lightport-custom-host': `http://127.0.0.1:${providerPort}` } : {}),
    },
    method: 'POST',
    payload: JSON.stringify(body),
    url: '/v1/images/generations',
  });

  return {
    contentType: response.headers['content-type'],
    raw: response.body,
    status: response.statusCode,
  };
};

const generate = async (provider: string, body: Record<string, unknown>, providerPort?: number) => {
  const { raw, status } = await generateRaw(provider, body, providerPort);

  return { body: JSON.parse(raw), status };
};

describe('image generation', () => {
  it('sends openrouter its own image endpoint and parameters', async () => {
    const image = Buffer.from('not really a png').toString('base64');
    const { port, received } = await startProvider({
      body: JSON.stringify({
        created: 1,
        data: [{ b64_json: image, media_type: 'image/png' }],
        usage: { total_tokens: 4175 },
      }),
      contentType: 'application/json',
      status: 200,
    });

    const { body, status } = await generate(
      'openrouter',
      {
        aspect_ratio: '1:1',
        model: 'google/gemini-2.5-flash-image',
        n: 1,
        prompt: 'a cat',
        seed: 7,
        size: '1024x1024',
      },
      port,
    );

    // OpenRouter serves images from `/v1/images`, not through chat completions.
    expect(received.path).toBe('/v1/images');
    expect(JSON.parse(received.body ?? '')).toEqual({
      aspect_ratio: '1:1',
      model: 'google/gemini-2.5-flash-image',
      n: 1,
      prompt: 'a cat',
      seed: 7,
      size: '1024x1024',
    });

    expect(status).toBe(200);
    expect(body.data[0].b64_json).toBe(image);
    expect(body.usage).toEqual({ total_tokens: 4175 });
  });

  it('reports an openrouter failure in the shape a client reads', async () => {
    const { port } = await startProvider({
      body: JSON.stringify({ error: { code: 404, message: 'No model found' } }),
      contentType: 'application/json',
      status: 404,
    });

    const { body, status } = await generate(
      'openrouter',
      { model: 'nope/nope', prompt: 'a cat' },
      port,
    );

    expect(status).toBe(404);
    expect(body.error).toMatchObject({ code: 404, message: 'openrouter error: No model found' });
    expect(body.provider).toBe('openrouter');
  });

  /**
   * OpenAI answers an image request carrying a bad key with `content-type:
   * text/plain` over a body that is JSON. That sends it down the text path,
   * which hands the transform the whole payload as one string — and passing it
   * through returned an `html-message` key wrapping an error no OpenAI client
   * can read, for the most ordinary failure there is.
   */
  it('unwraps an openai error that arrived mislabelled as text', async () => {
    const { port } = await startProvider({
      body: JSON.stringify({
        error: {
          code: 'invalid_api_key',
          message: 'Incorrect API key provided',
          param: null,
          type: 'invalid_request_error',
        },
      }),
      contentType: 'text/plain',
      status: 401,
    });

    const { body, status } = await generate(
      'openai',
      { model: 'gpt-image-1', prompt: 'a cat' },
      port,
    );

    expect(status).toBe(401);
    expect(body).not.toHaveProperty('html-message');
    expect(body.error).toMatchObject({
      code: 'invalid_api_key',
      message: 'openai error: Incorrect API key provided',
      type: 'invalid_request_error',
    });
  });

  /**
   * `stream` is read off the caller's request before the transform runs, so the
   * gateway used to commit to reading SSE whatever the provider was actually
   * asked for — and of the sixteen providers that generate images, all but two
   * strip `stream` from the request entirely. A single JSON body read as an
   * event stream yields no events, so the caller was answered 200 with an empty
   * body, having been billed for an image the gateway discarded.
   */
  it('returns the image when a provider answers a stream request with one body', async () => {
    const { port } = await startProvider({
      body: JSON.stringify({ created: 1, data: [{ b64_json: 'AAAA' }] }),
      contentType: 'application/json',
      status: 200,
    });

    const { contentType, raw, status } = await generateRaw(
      'openrouter',
      { model: 'x/y', prompt: 'a cat', stream: true },
      port,
    );

    expect(status).toBe(200);
    expect(raw).not.toBe('');
    expect(contentType).toContain('application/json');
    expect(JSON.parse(raw).data[0].b64_json).toBe('AAAA');
  });

  it('passes a real event stream through untouched', async () => {
    const { port } = await startProvider({
      body: `data: ${JSON.stringify({ type: 'image.partial', b64_json: 'AAAA' })}\n\ndata: [DONE]\n\n`,
      contentType: 'text/event-stream',
      status: 200,
    });

    const { contentType, raw, status } = await generateRaw(
      'openrouter',
      { model: 'x/y', prompt: 'a cat', stream: true },
      port,
    );

    expect(status).toBe(200);
    expect(contentType).toContain('text/event-stream');
    expect(raw).toContain('image.partial');
  });

  it('unwraps a mislabelled success rather than handing back the wrapper', async () => {
    const { port } = await startProvider({
      body: JSON.stringify({ created: 1, data: [{ b64_json: 'AAAA' }] }),
      contentType: 'text/plain',
      status: 200,
    });

    const { body, status } = await generate(
      'openai',
      { model: 'gpt-image-1', prompt: 'a cat' },
      port,
    );

    expect(status).toBe(200);
    expect(body).not.toHaveProperty('html-message');
    expect(body.data[0].b64_json).toBe('AAAA');
  });

  it('reports the body when a mislabelled error is not JSON at all', async () => {
    const { port } = await startProvider({
      body: '<html><body>502 Bad Gateway</body></html>',
      contentType: 'text/html',
      status: 502,
    });

    const { body, status } = await generate(
      'openai',
      { model: 'gpt-image-1', prompt: 'a cat' },
      port,
    );

    expect(status).toBe(502);
    expect(body.error.message).toContain('502 Bad Gateway');
  });

  /**
   * `{...response.error}` spread a string into nothing, so a provider reporting
   * a failure as `{"error": "nope"}` produced `openai error: undefined` — the
   * one word that says less than saying nothing.
   */
  it('reports a failure carried as a bare string', async () => {
    const { port } = await startProvider({
      body: JSON.stringify({ error: 'nope' }),
      contentType: 'text/plain',
      status: 500,
    });

    const { body, status } = await generate(
      'openai',
      { model: 'gpt-image-1', prompt: 'a cat' },
      port,
    );

    expect(status).toBe(500);
    expect(body.error.message).not.toContain('undefined');
    expect(body.error.message).toContain('nope');
  });

  it.each(['openrouter', 'azure-openai'])(
    'normalizes a %s error that arrived mislabelled as text',
    async (provider) => {
      const { port } = await startProvider({
        body: JSON.stringify({ error: { code: 'invalid_api_key', message: 'bad key' } }),
        contentType: 'text/plain',
        status: 401,
      });

      const { body, status } = await generate(provider, { model: 'x/y', prompt: 'a cat' }, port);

      expect(status).toBe(401);
      expect(body).not.toHaveProperty('html-message');
      expect(body.error.message).toBe(`${provider} error: bad key`);
    },
  );

  it('answers a provider that generates no images as the caller`s mistake', async () => {
    const { body, status } = await generate('anthropic', {
      model: 'claude-sonnet-4-5',
      prompt: 'a cat',
    });

    expect(status).toBe(400);
    expect(body.error).toMatchObject({
      message: 'imageGenerate is not supported by anthropic',
      type: 'invalid_request_error',
    });
  });
});
