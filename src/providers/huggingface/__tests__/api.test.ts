import createApp from '../../../index';
import HuggingfaceAPIConfig from '../api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const addressFor = async (fn: string, providerOptions: Record<string, unknown> = {}) => {
  const args = { fn, gatewayRequestBodyJSON: { model: 'openai/gpt-oss-120b' }, providerOptions };

  return (
    (await HuggingfaceAPIConfig.getBaseURL(args as any)) +
    HuggingfaceAPIConfig.getEndpoint(args as any)
  );
};

describe('huggingface address', () => {
  // The model goes in the body, where the router reads it, rather than in a path
  // under a host that no longer resolves.
  it('sends chat completions to the router by default', async () => {
    expect(await addressFor('chatComplete')).toBe(
      'https://router.huggingface.co/v1/chat/completions',
    );
  });

  it('sends chat completions to a base url the caller names', async () => {
    expect(
      await addressFor('chatComplete', {
        huggingfaceBaseUrl: 'https://example.endpoints.huggingface.cloud',
      }),
    ).toBe('https://example.endpoints.huggingface.cloud/v1/chat/completions');
  });

  it('sends text completions to a base url the caller names', async () => {
    expect(
      await addressFor('complete', {
        huggingfaceBaseUrl: 'https://example.endpoints.huggingface.cloud',
      }),
    ).toBe('https://example.endpoints.huggingface.cloud/v1/completions');
  });
});

describe('huggingface text completions without a base url', () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    app = createApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  // The router serves chat alone, so the request is refused with what would make
  // it answerable instead of being sent somewhere that can only 404.
  it('is refused, naming the setting that would serve it', async () => {
    const response = await app.inject({
      headers: {
        authorization: 'Bearer hf_not_a_real_token',
        'content-type': 'application/json',
        'x-lightport-provider': 'huggingface',
      },
      method: 'POST',
      payload: { model: 'openai/gpt-oss-120b', prompt: 'once upon a time' },
      url: '/v1/completions',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain('huggingface_base_url');
  });
});
