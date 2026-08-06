import { describe, expect, it } from 'vitest';
import { SALADCLOUD, VALID_PROVIDERS } from '../../globals';
import { transformUsingProviderConfig } from '../../services/transformToProviderRequest';
import type { Options, Params } from '../../types/requestBody';
import ProviderConfigs from '../index';
import type { ChatCompletionResponse, ErrorResponse, ProviderConfig } from '../types';

const saladcloud = (ProviderConfigs as any).saladcloud;

const complete = (response: Record<string, unknown>, status = 200, strict = true) =>
  saladcloud.responseTransforms.chatComplete(response, status, new Headers(), strict);

describe('saladcloud is reachable', () => {
  it('is registered and allowed as a provider', () => {
    expect(saladcloud).toBeDefined();
    expect(VALID_PROVIDERS).toContain(SALADCLOUD);
  });

  it('uses the SaladCloud chat completions endpoint and bearer authentication', () => {
    const providerOptions = { apiKey: 'test-key' } as Options;

    expect(saladcloud.api.getBaseURL({ providerOptions })).toBe('https://ai.salad.cloud/v1');
    expect(saladcloud.api.getEndpoint({ fn: 'chatComplete', providerOptions })).toBe(
      '/chat/completions',
    );
    expect(saladcloud.api.headers({ providerOptions })).toEqual({
      Authorization: 'Bearer test-key',
    });
  });

  it('passes streamed OpenAI-compatible chunks through unchanged', () => {
    expect(saladcloud.responseTransforms['stream-chatComplete']).toBeUndefined();
  });
});

describe('what saladcloud is sent', () => {
  it('defaults only to the requested 35B model', () => {
    const request = transformUsingProviderConfig(
      saladcloud.chatComplete as ProviderConfig,
      { messages: [{ role: 'user', content: 'hi' }] } as Params,
    );

    expect(request.model).toBe('qwen3.6-35b-a3b');
  });

  it('keeps supported OpenAI and SaladCloud parameters', () => {
    const request = transformUsingProviderConfig(
      saladcloud.chatComplete as ProviderConfig,
      {
        model: 'qwen3.6-35b-a3b',
        messages: [{ role: 'user', content: 'hi' }],
        reasoning_effort: 'medium',
        top_k: 40,
        chat_template_kwargs: { enable_thinking: false },
        tools: [{ type: 'function', function: { name: 'answer' } }],
        response_format: { type: 'json_object' },
      } as Params,
    );

    expect(request).toMatchObject({
      model: 'qwen3.6-35b-a3b',
      reasoning_effort: 'medium',
      top_k: 40,
      chat_template_kwargs: { enable_thinking: false },
      response_format: { type: 'json_object' },
    });
    expect(request.tools).toHaveLength(1);
  });

  it('drops OpenAI-only parameters the SaladCloud endpoint does not accept', () => {
    const request = transformUsingProviderConfig(
      saladcloud.chatComplete as ProviderConfig,
      {
        model: 'qwen3.6-35b-a3b',
        messages: [{ role: 'user', content: 'hi' }],
        service_tier: 'auto',
        store: true,
        verbosity: 'high',
      } as Params,
    );

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

  it('preserves reasoning and exposes it to the Responses adapter', () => {
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

  it('normalizes SaladCloud problem details', () => {
    const result = complete(
      { status: 503, title: 'Service Unavailable', type: 'about:blank' },
      503,
    ) as ErrorResponse;

    expect(result.provider).toBe(SALADCLOUD);
    expect(result.error.message).toContain('Service Unavailable');
    expect(result.error.code).toBe('503');
  });
});
