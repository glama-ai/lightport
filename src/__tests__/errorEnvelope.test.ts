import createApp from '../index';
import { afterEach, describe, expect, it } from 'vitest';

const apps: Array<ReturnType<typeof createApp>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const post = async (url: string, headers: Record<string, string>, body: unknown = {}) => {
  const app = createApp();
  apps.push(app);

  const response = await app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', ...headers },
    payload: JSON.stringify(body),
  });

  return { body: response.json(), status: response.statusCode };
};

/**
 * Making providers OpenAI-compatible is what the gateway is for, and an error is
 * as much a part of that interface as a completion. These are the gateway's own
 * failures — not a provider's — and they used to leave as `{status, message}`,
 * which an OpenAI client does not raise on and a lenient one reads as a
 * completion with no choices: a failure indistinguishable from an empty answer.
 */
describe('errors the gateway raises itself', () => {
  it('rejects an unknown provider in the shape a client reads', async () => {
    const { body, status } = await post('/v1/chat/completions', {
      authorization: 'Bearer sk-not-a-real-key',
      'x-lightport-provider': 'not-a-provider',
    });

    expect(status).toBe(400);
    expect(body.error).toEqual({
      code: null,
      message: 'Invalid provider passed',
      param: null,
      type: 'invalid_request_error',
    });
    expect(body).not.toHaveProperty('status');
  });

  it('answers a provider that does not implement the endpoint as the caller`s mistake', async () => {
    // Raised as a 500 this told an OpenAI client to retry — three times, with
    // backoff — a request no attempt could have satisfied. 53 of the 75
    // registered providers have no `complete` config.
    const { body, status } = await post(
      '/v1/completions',
      { authorization: 'Bearer sk-not-a-real-key', 'x-lightport-provider': 'groq' },
      { model: 'llama-3.1-8b-instant', prompt: 'hi' },
    );

    expect(status).toBe(400);
    expect(body.error).toMatchObject({
      message: 'complete is not supported by groq',
      type: 'invalid_request_error',
    });
  });

  // `lightport` passes header validation and has no provider implementation, so
  // it is the one input that reaches a handler's own catch on every route.
  it.each([
    ['/v1/chat/completions', { messages: [{ content: 'hi', role: 'user' }], model: 'gpt-4o' }],
    ['/v1/responses', { input: 'hi', model: 'gpt-4o' }],
  ])('answers an error raised inside %s in the same shape', async (url, payload) => {
    const { body, status } = await post(
      url,
      { authorization: 'Bearer sk-not-a-real-key', 'x-lightport-provider': 'lightport' },
      payload,
    );

    expect(status).toBe(400);
    expect(body.error).toMatchObject({
      message: 'Provider "lightport" is not supported',
      type: 'invalid_request_error',
    });
    expect(body).not.toHaveProperty('status');
  });

  it('bounds what a caller can put in the field every client logs', async () => {
    // The issues come from the caller's own config, nested targets recurse, and
    // a rejected provider name is reported with the full list of valid ones.
    const { body, status } = await post('/v1/chat/completions', {
      authorization: 'Bearer sk-not-a-real-key',
      'x-lightport-config': JSON.stringify({
        provider: 'openai',
        targets: Array.from({ length: 400 }, () => ({ provider: 'nope' })),
      }),
    });

    expect(status).toBe(400);
    expect(body.error.message.length).toBeLessThan(2_100);
    expect(body.error.message).toContain('Invalid config passed');
  });

  it('rejects a malformed config without echoing it back', async () => {
    const secret = 'sk-live-do-not-echo-this-back';

    const { body, status } = await post('/v1/chat/completions', {
      authorization: 'Bearer sk-not-a-real-key',
      'x-lightport-config': `{not json ${secret}`,
    });

    expect(status).toBe(400);
    expect(body.error.type).toBe('invalid_request_error');

    // The property the test is named for. Asserting only the status and type
    // left it untested: reflecting the whole header into the message would put
    // whatever the caller misconfigured — a key, a host — into the one field
    // every client writes to its logs.
    expect(JSON.stringify(body)).not.toContain(secret);
  });

  it('answers an endpoint it does not route in the same shape', async () => {
    // Every OpenAI endpoint the gateway does not implement lands here —
    // embeddings, models, moderations, files — as does any wrong method on one
    // it does. This was the highest-traffic path still answering in a shape an
    // OpenAI client discards.
    const app = createApp();
    apps.push(app);

    const response = await app.inject({ method: 'POST', url: '/v1/embeddings' });

    expect(response.statusCode).toBe(404);
    expect(response.json().error).toMatchObject({ type: 'invalid_request_error' });
  });

  it.each([
    ['multipart/form-data; boundary=xyz', 'not valid multipart'],
    ['application/json', '{not json'],
  ])('answers a body it cannot read as the caller`s mistake (%s)', async (contentType, payload) => {
    // A throw from the body parser escaped every handler's catch to Fastify's
    // own, which answered 500 in the pre-gateway shape — telling an OpenAI
    // client to retry, three times with backoff, a body no attempt could parse,
    // and paging someone once per attempt.
    const app = createApp();
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'content-type': contentType, 'x-lightport-provider': 'openai' },
      payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({ type: 'invalid_request_error' });
    expect(response.json()).not.toHaveProperty('status');
  });
});
