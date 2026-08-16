import { describe, expect, it } from 'vitest';
import { SALADCLOUD } from '../../globals';
import { transformUsingProviderConfig } from '../../services/transformToProviderRequest';
import type { Options, Params } from '../../types/requestBody';
import ProviderConfigs from '../index';
import type { ChatCompletionResponse, ErrorResponse, ProviderConfig } from '../types';
import { VALID_PROVIDERS } from '../valid';

const saladcloud = (ProviderConfigs as any).saladcloud;

const complete = (response: Record<string, unknown>, status = 200, strict = true) =>
  saladcloud.responseTransforms.chatComplete(response, status, new Headers(), strict);

const sent = (params: Partial<Params>) =>
  transformUsingProviderConfig(saladcloud.chatComplete as ProviderConfig, {
    messages: [{ role: 'user', content: 'hi' }],
    ...params,
  } as Params);

describe('saladcloud is reachable', () => {
  it('is registered and allowed as a provider', () => {
    expect(saladcloud).toBeDefined();
    expect(VALID_PROVIDERS).toContain(SALADCLOUD);
  });

  it('is addressed where SaladCloud answers, with bearer authentication', () => {
    const providerOptions = { apiKey: 'test-key' } as Options;
    const base = saladcloud.api.getBaseURL({ providerOptions });
    const path = saladcloud.api.getEndpoint({ fn: 'chatComplete', providerOptions });

    // The whole address, not the halves: the version segment sits in the path so
    // that a custom host replacing the base URL cannot drop it.
    expect(`${base}${path}`).toBe('https://ai.salad.cloud/v1/chat/completions');
    expect(saladcloud.api.headers({ providerOptions })).toEqual({
      Authorization: 'Bearer test-key',
    });
  });

  it('passes streamed OpenAI-compatible chunks through unchanged', () => {
    expect(saladcloud.responseTransforms['stream-chatComplete']).toBeUndefined();
  });
});

describe('what saladcloud is sent', () => {
  it('defaults to the model SaladCloud serves, not OpenAI’s', () => {
    expect(sent({}).model).toBe('qwen3.6-35b-a3b');
  });

  it('keeps the parameters SaladCloud takes, its own among them', () => {
    const request = sent({
      model: 'qwen3.6-35b-a3b',
      reasoning_effort: 'medium',
      top_k: 40,
      chat_template_kwargs: { enable_thinking: false },
      tools: [{ type: 'function', function: { name: 'answer' } }],
      response_format: { type: 'json_object' },
    } as Partial<Params>);

    expect(request).toMatchObject({
      model: 'qwen3.6-35b-a3b',
      reasoning_effort: 'medium',
      top_k: 40,
      chat_template_kwargs: { enable_thinking: false },
      response_format: { type: 'json_object' },
    });
    expect(request.tools).toHaveLength(1);
  });

  it('holds back the OpenAI-only parameters it does not', () => {
    const request = sent({ service_tier: 'auto', store: true, verbosity: 'high' } as Partial<Params>);

    expect(request).not.toHaveProperty('service_tier');
    expect(request).not.toHaveProperty('store');
    expect(request).not.toHaveProperty('verbosity');
  });
});

describe('what saladcloud answers with', () => {
  const reply = (message: Record<string, unknown>) => ({
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 1_735_891_200,
    model: 'qwen3.6-35b-a3b',
    choices: [{ index: 0, message, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 4, total_tokens: 5 },
  });

  it('has its thinking read, under the name SaladCloud gives it', () => {
    // `reasoning_text` is SaladCloud's own name for it. The shared reader knows
    // `reasoning_content` and `reasoning`, so without the rename the thinking
    // never reaches `content_blocks` — the only form the Responses adapter reads
    // a reasoning turn from when it is not streaming.
    const result = complete(
      reply({ role: 'assistant', reasoning_text: 'Think briefly.', content: 'Hello.' }),
      200,
      false,
    ) as ChatCompletionResponse;

    expect(result.provider).toBe(SALADCLOUD);
    expect((result.choices[0].message as any).reasoning_content).toBe('Think briefly.');
    expect((result.choices[0].message as any).content_blocks).toContainEqual({
      type: 'thinking',
      thinking: 'Think briefly.',
    });
  });

  it('says nothing extra to a caller who asked for strict compliance', () => {
    const result = complete(
      reply({ role: 'assistant', reasoning_text: 'Think briefly.', content: 'Hello.' }),
      200,
      true,
    ) as ChatCompletionResponse;

    expect((result.choices[0].message as any).content_blocks).toBeUndefined();
  });

  it('has its problem details read as the standard they are', () => {
    // SaladCloud answers failures as RFC 7807, verified live against
    // `https://ai.salad.cloud/v1/chat/completions` with no key.
    const result = complete(
      { status: 401, title: 'Unauthorized', type: 'about:blank' },
      401,
    ) as ErrorResponse;

    expect(result.provider).toBe(SALADCLOUD);
    expect(result.error.message).toContain('Unauthorized');
    expect(result.error.code).toBe('401');
  });
});
