import { describe, expect, it } from 'vitest';
import { transformUsingProviderConfig } from '../../../services/transformToProviderRequest';
import type { Params } from '../../../types/requestBody';
import type { ProviderConfig } from '../../types';
import { defineOpenAICompatibleProvider } from '../define';

const declare = (overrides: Record<string, any> = {}) =>
  defineOpenAICompatibleProvider({
    name: 'testprovider',
    baseURL: 'https://api.test.example',
    endpoints: { chatComplete: { path: '/v1/chat/completions', defaultModel: 'test-small' } },
    ...overrides,
  } as any);

const modelSentBy = (config: any) =>
  transformUsingProviderConfig(config.chatComplete as ProviderConfig, {
    messages: [{ role: 'user', content: 'hi' }],
  } as Params).model;

describe('the model a request that names none is sent with', () => {
  it('is the one the provider named', () => {
    expect(modelSentBy(declare())).toBe('test-small');
  });

  it('is nothing at all when the provider named none', () => {
    // Not OpenAI's `gpt-3.5-turbo`, which is what this base carries and what
    // every provider that said nothing has been sending. Nothing is sent, the
    // provider says which field it wanted, and the caller reads that.
    const config = declare({
      endpoints: { chatComplete: { path: '/v1/chat/completions', defaultModel: null } },
    });

    expect(modelSentBy(config)).toBeUndefined();
  });

  it('is still the one the caller named, when they named one', () => {
    const config = declare();
    const sent = transformUsingProviderConfig(config.chatComplete as ProviderConfig, {
      model: 'something-else',
      messages: [{ role: 'user', content: 'hi' }],
    } as Params);

    expect(sent.model).toBe('something-else');
  });

  it('is named separately for embeddings, which are not chat models', () => {
    const config = declare({
      endpoints: {
        chatComplete: { path: '/v1/chat/completions', defaultModel: 'test-small' },
        embed: { path: '/v1/embeddings', defaultModel: 'test-embed' },
      },
    });

    const sent = transformUsingProviderConfig(config.embed as ProviderConfig, {
      input: 'hi',
    } as Params);

    expect(sent.model).toBe('test-embed');
  });
});

describe('where the version segment is written', () => {
  it('is refused in the base URL', () => {
    // A custom host replaces the base URL whole, so a `/v1` written there is
    // dropped for that caller and the request goes somewhere the provider does
    // not serve.
    expect(() => declare({ baseURL: 'https://api.test.example/v1' })).toThrow(/version segment/);
  });

  it('is accepted in the endpoint path, where a custom host cannot lose it', () => {
    const config = declare();

    expect(config.api.getEndpoint({ fn: 'chatComplete' } as any)).toBe('/v1/chat/completions');
    expect(config.api.getBaseURL({} as any)).toBe('https://api.test.example');
  });
});

describe('the endpoints a provider serves', () => {
  it('are the only ones it answers for', () => {
    const config = declare();

    expect(config.chatComplete).toBeDefined();
    // Not a silent fallthrough to OpenAI's path: asking for one it does not
    // serve is refused by name, upstream of any request being sent.
    expect(config.complete).toBeUndefined();
    expect(config.embed).toBeUndefined();
    expect(config.api.getEndpoint({ fn: 'complete' } as any)).toBe('');
  });

  it('must each name a path that is one', () => {
    expect(() =>
      declare({
        endpoints: { chatComplete: { path: 'v1/chat/completions', defaultModel: null } },
      }),
    ).toThrow(/must start with a slash/);
  });
});

describe('what a declared provider is sent', () => {
  it('carries the key as a bearer token', async () => {
    const headers = await declare().api.headers({
      providerOptions: { apiKey: 'sk-test' },
    } as any);

    expect(headers.Authorization).toBe('Bearer sk-test');
  });

  it('carries whatever else the provider asked for alongside it', async () => {
    const config = declare({ headers: () => ({ 'X-Title': 'lightport' }) });
    const headers = await config.api.headers({ providerOptions: { apiKey: 'sk-test' } } as any);

    expect(headers).toEqual({ Authorization: 'Bearer sk-test', 'X-Title': 'lightport' });
  });

  it('leaves out the parameters the provider does not take', () => {
    const config = declare({
      endpoints: {
        chatComplete: { path: '/v1/chat/completions', defaultModel: 'test-small', exclude: ['tools', 'seed'] },
      },
    });

    const sent = transformUsingProviderConfig(config.chatComplete as ProviderConfig, {
      messages: [{ role: 'user', content: 'hi' }],
      seed: 1,
      tools: [{ type: 'function', function: { name: 'f' } }],
      temperature: 0.5,
    } as Params);

    expect(sent).not.toHaveProperty('tools');
    expect(sent).not.toHaveProperty('seed');
    expect(sent.temperature).toBe(0.5);
  });
});

describe('a config a declaration produced', () => {
  it('shares no parameter object with any other declaration', () => {
    // Two providers holding one object is how writing a default for either one
    // wrote it for both, and for OpenAI itself.
    const one = declare();
    const two = declare({
      name: 'other',
      endpoints: { chatComplete: { path: '/v1/chat/completions', defaultModel: 'other-small' } },
    });

    expect(one.chatComplete).not.toBe(two.chatComplete);
    expect((one.chatComplete as any).model).not.toBe((two.chatComplete as any).model);
    expect(modelSentBy(one)).toBe('test-small');
    expect(modelSentBy(two)).toBe('other-small');
  });

  it('says whether the provider serves the Responses API itself', () => {
    expect(declare().nativeResponses).toBe(false);
    expect(declare({ nativeResponses: true }).nativeResponses).toBe(true);
  });
});
