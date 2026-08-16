import { describe, expect, it } from 'vitest';
import ProviderConfigs from '../index';
import { VALID_PROVIDERS } from '../valid';
import { transformUsingProviderConfig } from '../../services/transformToProviderRequest';
import type { ChatCompletionResponse, ErrorResponse, ProviderConfig } from '../types';
import type { Options, Params } from '../../types/requestBody';

const requesty = (ProviderConfigs as any).requesty;

const complete = (response: Record<string, unknown>, status = 200, strictOpenAiCompliance = true) =>
  requesty.responseTransforms.chatComplete(response, status, new Headers(), strictOpenAiCompliance);

const reply = (message: Record<string, unknown>) => ({
  id: 'c1',
  object: 'chat.completion',
  created: 1_700_000_000,
  model: 'anthropic/claude-sonnet-4-5',
  choices: [{ index: 0, message, finish_reason: 'stop' }],
  usage: {
    prompt_tokens: 10,
    completion_tokens: 90,
    total_tokens: 100,
    completion_tokens_details: { reasoning_tokens: 80 },
  },
});

describe('requesty is reachable', () => {
  it('is registered and allowed as a provider', () => {
    // Registering a provider without listing it as a valid one leaves it
    // unreachable: the header is refused before anything else happens.
    expect(requesty).toBeDefined();
    expect(VALID_PROVIDERS).toContain('requesty');
  });

  it('is addressed where Requesty answers', () => {
    expect(requesty.api.getBaseURL({ providerOptions: {} as Options })).toBe(
      'https://router.requesty.ai/v1',
    );
    expect(requesty.api.getEndpoint({ fn: 'chatComplete', providerOptions: {} as Options })).toBe(
      '/chat/completions',
    );
  });

  it('carries the key as a bearer token', () => {
    const headers = requesty.api.headers({ providerOptions: { apiKey: 'sk-test' } as Options });

    expect(headers.Authorization).toBe('Bearer sk-test');
    // Requesty reads these to attribute the request in its own dashboard.
    expect(headers['HTTP-Referer']).toBe('https://lightport.ai/');
    expect(headers['X-Title']).toBe('lightport');
  });

  it('has no streaming transform, so a streamed answer is passed on whole', () => {
    // Deliberate: the adapters read `delta.reasoning_content` themselves, so a
    // streamed reasoner reaches them intact without one. A transform here could
    // only lose something.
    expect(requesty.responseTransforms['stream-chatComplete']).toBeUndefined();
  });
});

describe('what requesty is sent', () => {
  it('takes OpenAI parameters under their own names', () => {
    // Requesty answers in OpenAI's shape and reads `reasoning_effort` as it is,
    // rather than the object OpenRouter takes — so nothing is renamed.
    const request = transformUsingProviderConfig(
      requesty.chatComplete as ProviderConfig,
      {
        model: 'anthropic/claude-sonnet-4-5',
        messages: [{ role: 'user', content: 'hi' }],
        reasoning_effort: 'high',
        max_completion_tokens: 256,
        tools: [{ type: 'function', function: { name: 'f' } }],
      } as Params,
    );

    expect(request.model).toBe('anthropic/claude-sonnet-4-5');
    expect(request.reasoning_effort).toBe('high');
    expect(request.max_completion_tokens).toBe(256);
    expect(request.tools).toHaveLength(1);
    expect(request).not.toHaveProperty('reasoning');
  });

  it('falls back to a model Requesty can actually route', () => {
    // Requesty names its models for the house that made them. The bare name this
    // base carries is not one of them, so a request naming no model has to be
    // given one that is.
    const request = transformUsingProviderConfig(
      requesty.chatComplete as ProviderConfig,
      {
        messages: [{ role: 'user', content: 'hi' }],
      } as Params,
    );

    expect(request.model).toContain('/');
    expect(request.model).toBe('openai/gpt-4o-mini');
  });
});

describe('what requesty answers with', () => {
  it('keeps the reasoning the model reported', () => {
    const result = complete(
      reply({ role: 'assistant', content: '', reasoning_content: 'all of it' }),
    ) as ChatCompletionResponse;

    expect((result.choices[0].message as any).reasoning_content).toBe('all of it');
    expect(result.provider).toBe('requesty');
  });

  it('offers the thinking as a content block once compliance is relaxed', () => {
    // The only form the Responses adapter reads a reasoning turn from when it is
    // not streaming, so without it a reasoner reaches that API saying nothing.
    const result = complete(
      reply({ role: 'assistant', content: '', reasoning_content: 'all of it' }),
      200,
      false,
    ) as ChatCompletionResponse;

    expect((result.choices[0].message as any).content_blocks).toContainEqual({
      type: 'thinking',
      thinking: 'all of it',
    });
  });

  it('carries the rest of the answer whole', () => {
    // Nothing is rebuilt field by field, which is what loses a field nobody
    // thought to name.
    const result = complete(
      reply({
        role: 'assistant',
        content: 'four',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }],
      }),
    ) as ChatCompletionResponse;

    expect(result.choices[0].message.tool_calls).toHaveLength(1);
    expect(result.choices[0].finish_reason).toBe('stop');
    expect(result.usage?.completion_tokens_details?.reasoning_tokens).toBe(80);
  });

  it('says nothing about reasoning when the model did none', () => {
    const message = (complete(reply({ role: 'assistant', content: 'four' }), 200, false) as any)
      .choices[0].message;

    expect(message).not.toHaveProperty('reasoning_content');
    expect(message).not.toHaveProperty('content_blocks');
  });

  it('reports a refusal as the refusal it is', () => {
    // Requesty's own envelope, which names an origin and a message and nothing
    // else — no type, no param, no code.
    const result = complete(
      { error: { origin: 'router', message: 'Unauthorized' } },
      401,
    ) as ErrorResponse;

    expect(result.error.message).toContain('Unauthorized');
    expect(result.provider).toBe('requesty');
    // Named for what it is, rather than left to arrive as the unreadable answer
    // an unrecognised body would be.
    expect(result.error.message).not.toContain('Invalid response received');
  });

  it('reports a response it genuinely cannot read', () => {
    const result = complete({ something: 'unexpected' }) as ErrorResponse;

    expect(result.error.message).toContain('Invalid response received');
  });

  it('does not fail the request over an answer naming no choices', () => {
    // A body naming the field and leaving it null passes an `in` test and then
    // fails on the first thing done with it — a 500 of the gateway's own making.
    for (const body of [{ choices: null }, { choices: 'nonsense' }]) {
      expect(() => complete(body)).not.toThrow();
      expect((complete(body) as ErrorResponse).error.message).toContain(
        'Invalid response received',
      );
    }
  });
});
