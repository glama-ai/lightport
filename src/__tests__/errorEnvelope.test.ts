import createApp from '../index';
import { logger } from '../logger';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
    // The issues come from the caller's own config: an array is reported an
    // entry at a time, and a rejected provider name is reported with the whole
    // list of valid ones. The worst case used to be far worse — nested `targets`
    // recursed, so a config that still fitted in a header could produce
    // thousands of issues — but targets are refused ahead of validation now, so
    // what is left is bounded by the issue cap and the length cap together.
    const { body, status } = await post('/v1/chat/completions', {
      authorization: 'Bearer sk-not-a-real-key',
      'x-lightport-config': JSON.stringify({
        provider: 'nope',
        api_key: 'k',
        forward_headers: Array.from({ length: 500 }, () => 1),
      }),
    });

    expect(status).toBe(400);
    expect(body.error.message.length).toBeLessThan(2_100);
    expect(body.error.message).toContain('Invalid config passed');
    expect(body.error.message).toContain('more)');
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

  // `tryPost` calls one provider once and there is no target resolution, so a
  // config naming targets names no provider either and the request was already
  // dead — on `Provider ""`, a reason that sent the caller to the wrong place.
  it.each([
    ['strategy and targets', { strategy: { mode: 'fallback' }, targets: [{ provider: 'openai' }] }],
    ['targets alone', { targets: [{ provider: 'openai', api_key: 'k' }] }],
  ])('refuses config it cannot route: %s', async (_name, config) => {
    const { body, status } = await post('/v1/chat/completions', {
      authorization: 'Bearer sk-not-a-real-key',
      'x-lightport-config': JSON.stringify(config),
    });

    expect(status).toBe(400);
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toContain('Unsupported config');
  });

  it.each([
    ['retry', { provider: 'openai', api_key: 'k', retry: { attempts: 3 } }],
    ['cache', { provider: 'openai', api_key: 'k', cache: { mode: 'simple' } }],
    ['weight', { provider: 'openai', api_key: 'k', weight: 1 }],
    ['on_status_codes', { provider: 'openai', api_key: 'k', on_status_codes: [429] }],
    ['retry alone, provider from the header', { retry: { attempts: 3 } }],
    ['input_guardrails', { provider: 'openai', api_key: 'k', input_guardrails: [{ id: 'g' }] }],
    ['output_guardrails', { provider: 'openai', api_key: 'k', output_guardrails: [{ id: 'g' }] }],
    [
      'before_request_hooks',
      { provider: 'openai', api_key: 'k', before_request_hooks: [{ type: 'guardrail' }] },
    ],
    [
      'after_request_hooks',
      { provider: 'openai', api_key: 'k', after_request_hooks: [{ type: 'guardrail' }] },
    ],
    ['guardrails alone, provider from the header', { input_guardrails: [{ id: 'g' }] }],
  ])('serves config it does not act on, and says so in the log: %s', async (_name, config) => {
    // Nothing here is honoured, and the warning is where that is said. Refusing
    // instead would answer a setting that quietly does nothing with a gateway
    // that serves nothing — at deploy time, and hardest on whoever was careful
    // enough to configure retries at all. A caller arriving from a gateway that
    // did implement these should not meet an outage for it.
    const { status } = await post('/v1/chat/completions', {
      authorization: 'Bearer sk-not-a-real-key',
      'x-lightport-provider': 'openai',
      'x-lightport-config': JSON.stringify(config),
    });

    expect(status).not.toBe(400);
  });

  it.each([
    [
      'named in the config',
      {
        'x-lightport-config': JSON.stringify({
          provider: 'openai',
          api_key: 'k',
          retry: { attempts: 3 },
          input_guardrails: [{ id: 'g' }],
          after_request_hooks: [{ type: 'guardrail' }],
        }),
      },
      ['retry', 'input_guardrails', 'after_request_hooks'],
    ],
    [
      'named as headers of their own',
      {
        'x-lightport-default-input-guardrails': JSON.stringify([{ id: 'g' }]),
        'x-lightport-default-output-guardrails': JSON.stringify([{ id: 'g' }]),
      },
      ['x-lightport-default-input-guardrails', 'x-lightport-default-output-guardrails'],
    ],
    [
      'named as the header forms of the config keys',
      { 'x-lightport-cache': 'simple', 'x-lightport-retry-count': '3' },
      ['x-lightport-cache', 'x-lightport-retry-count'],
    ],
    [
      'named as the config defaults the headers overwrite',
      {
        'x-lightport-config': JSON.stringify({
          provider: 'openai',
          api_key: 'k',
          default_output_guardrails: [{ id: 'g' }],
        }),
      },
      ['default_output_guardrails'],
    ],
  ])('says in the log which settings it will not act on: %s', async (_name, headers, expected) => {
    // The warning is the whole of what is done about these, so it is the whole
    // of what there is to test. Someone who set `output_guardrails` believes
    // what the model says is being screened; the log is the only place that says
    // it is not — and the guardrail headers are read whether or not a config was
    // sent, so a caller naming only those would otherwise be told nothing.
    const warnings: unknown[] = [];
    const warn = vi.spyOn(logger, 'warn').mockImplementation(((obj: any) => {
      warnings.push(obj);
      return logger;
    }) as any);

    await post('/v1/chat/completions', {
      authorization: 'Bearer sk-not-a-real-key',
      'x-lightport-provider': 'openai',
      ...headers,
    });

    warn.mockRestore();

    const ignored = warnings.flatMap((entry: any) => entry?.ignored ?? []);
    for (const key of expected) {
      expect(ignored).toContain(key);
    }
  });

  it.each(['x-lightport-default-input-guardrails', 'x-lightport-default-output-guardrails'])(
    'answers a malformed %s as the caller`s mistake',
    async (header) => {
      // Read as JSON further on, outside any catch, so one that is not JSON left
      // as a 500 and a page — for a header naming something nothing acts on. A
      // malformed config has always been answered as a 400; this now matches.
      const { body, status } = await post('/v1/chat/completions', {
        authorization: 'Bearer sk-not-a-real-key',
        'x-lightport-provider': 'openai',
        [header]: 'not-json',
      });

      expect(status).toBe(400);
      expect(body.error).toMatchObject({ type: 'invalid_request_error' });
      expect(body.error.message).toContain(header);
      expect(body.error.message).toContain('valid json');
    },
  );

  it('names the keys it is refusing', async () => {
    // A fallback config used to die on `Provider "" is not supported` — naming a
    // provider the caller never wrote, because targets are never resolved and
    // the provider field stays empty. The reason has to be the actual one.
    const { body } = await post('/v1/chat/completions', {
      authorization: 'Bearer sk-not-a-real-key',
      'x-lightport-config': JSON.stringify({
        strategy: { mode: 'loadbalance' },
        targets: [{ provider: 'openai' }],
      }),
    });

    expect(body.error.message).toContain('strategy');
    expect(body.error.message).toContain('targets');
    expect(body.error.message).not.toContain('Provider ""');
  });

  it('does not answer one refusal by advertising another', async () => {
    // The schema's own message used to offer 'strategy' and 'targets', 'cache'
    // and 'retry' as ways to make a config valid — three keys the check above
    // refuses outright. A caller who took the advice got a second 400 for
    // having followed it.
    const { body, status } = await post('/v1/chat/completions', {
      authorization: 'Bearer sk-not-a-real-key',
      'x-lightport-config': JSON.stringify({ provider: 'openai' }),
    });

    expect(status).toBe(400);
    expect(body.error.message).toContain('Invalid configuration');

    for (const refused of ['strategy', 'targets', 'cache', 'retry']) {
      expect(body.error.message).not.toContain(refused);
    }
  });

  it.each([
    ['custom_host', { provider: 'openai', api_key: 'k', custom_host: 'https://h.example.com' }],
    ['request_timeout', { provider: 'openai', api_key: 'k', request_timeout: 5_000 }],
    ['forward_headers', { provider: 'openai', api_key: 'k', forward_headers: ['x-trace'] }],
  ])('still accepts config it does honour: %s', async (_name, config) => {
    // The other half of the refusal, and the one that keeps it honest: these
    // three reach `Options` as camelCase and are read on the request path, so
    // refusing them would break working callers. Anything but a 400 means the
    // request got past validation.
    const { status } = await post('/v1/chat/completions', {
      authorization: 'Bearer sk-not-a-real-key',
      'x-lightport-config': JSON.stringify(config),
    });

    expect(status).not.toBe(400);
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
