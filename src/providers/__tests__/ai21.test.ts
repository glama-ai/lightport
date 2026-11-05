import { describe, expect, it } from 'vitest';
import { AI21 } from '../../globals';
import { transformUsingProviderConfig } from '../../services/transformToProviderRequest';
import type { Options, Params } from '../../types/requestBody';
import ProviderConfigs from '../index';
import type { ChatCompletionResponse, ProviderConfig } from '../types';

const ai21 = (ProviderConfigs as any).ai21;

const sent = (params: Partial<Params>) =>
  transformUsingProviderConfig(
    ai21.chatComplete as ProviderConfig,
    {
      messages: [{ role: 'user', content: 'hi' }],
      model: 'jamba-large',
      ...params,
    } as Params,
  );

describe('ai21 is reachable', () => {
  // The path every Jamba request went to, `/{model}/chat`, answers 404.
  it('is addressed where Jamba answers, with bearer authentication', () => {
    const providerOptions = { apiKey: 'test-key' } as Options;
    const base = ai21.api.getBaseURL({ providerOptions });
    const path = ai21.api.getEndpoint({
      fn: 'chatComplete',
      gatewayRequestBodyJSON: { model: 'jamba-large' },
      providerOptions,
    });

    expect(`${base}${path}`).toBe('https://api.ai21.com/studio/v1/chat/completions');
    expect(ai21.api.headers({ providerOptions })).toEqual({ Authorization: 'Bearer test-key' });
  });

  // `/{model}/complete` and `/embed` answer 404 too, so neither is claimed.
  it('serves chat completions alone', () => {
    expect(ai21.chatComplete).toBeDefined();
    expect(ai21.complete).toBeUndefined();
    expect(ai21.embed).toBeUndefined();
  });

  it('passes streamed OpenAI-compatible chunks through unchanged', () => {
    expect(ai21.responseTransforms['stream-chatComplete']).toBeUndefined();
  });
});

describe('what ai21 is sent', () => {
  it('names the model in the body, under OpenAI’s parameter names', () => {
    const request = sent({ max_tokens: 64, stop: ['\n'], temperature: 0.4, top_p: 0.9 });

    expect(request).toMatchObject({
      max_tokens: 64,
      messages: [{ content: 'hi', role: 'user' }],
      model: 'jamba-large',
      stop: ['\n'],
      temperature: 0.4,
      top_p: 0.9,
    });
    // Jurassic-2's names, which Jamba does not read.
    expect(request).not.toHaveProperty('maxTokens');
    expect(request).not.toHaveProperty('topP');
  });

  it('sends no model when the caller names none', () => {
    const request = sent({ model: undefined });

    expect(request.model).toBeUndefined();
  });

  it('keeps tools, the JSON mode and the grounding documents', () => {
    const request = sent({
      documents: [{ content: 'The sky is green here.' }],
      response_format: { type: 'json_object' },
      tools: [{ function: { name: 'answer' }, type: 'function' }],
    } as Partial<Params>);

    expect(request.documents).toEqual([{ content: 'The sky is green here.' }]);
    expect(request.response_format).toEqual({ type: 'json_object' });
    expect(request.tools).toHaveLength(1);
  });

  it('sends the newer token limit under the only name AI21 documents', () => {
    const request = sent({ max_completion_tokens: 128 });

    expect(request.max_tokens).toBe(128);
    expect(request).not.toHaveProperty('max_completion_tokens');
  });

  it('turns a developer message into the system message AI21 knows', () => {
    const request = sent({
      messages: [
        { content: 'Be terse.', role: 'developer' },
        { content: 'hi', role: 'user' },
      ],
    } as Partial<Params>);

    expect(request.messages[0]).toEqual({ content: 'Be terse.', role: 'system' });
  });

  it('holds back the parameters AI21 does not document', () => {
    const request = sent({
      logprobs: true,
      presence_penalty: 0.5,
      seed: 7,
      service_tier: 'auto',
      tool_choice: 'auto',
    } as unknown as Partial<Params>);

    for (const param of ['logprobs', 'presence_penalty', 'seed', 'service_tier', 'tool_choice']) {
      expect(request).not.toHaveProperty(param);
    }
  });
});

describe('what ai21 answers with', () => {
  it('is read as the chat completion it is', () => {
    const result = ai21.responseTransforms.chatComplete(
      {
        choices: [
          {
            finish_reason: 'stop',
            index: 0,
            message: { content: 'Hello.', role: 'assistant' },
          },
        ],
        created: 1_735_891_200,
        id: 'chat-test',
        model: 'jamba-large',
        object: 'chat.completion',
        usage: { completion_tokens: 2, prompt_tokens: 3, total_tokens: 5 },
      },
      200,
      new Headers(),
      true,
    ) as ChatCompletionResponse;

    expect(result.provider).toBe(AI21);
    expect(result.choices[0].message.content).toBe('Hello.');
    expect(result.usage).toMatchObject({ completion_tokens: 2, prompt_tokens: 3, total_tokens: 5 });
  });

  it('has its failure named in an envelope the caller can read', () => {
    const result = ai21.responseTransforms.chatComplete(
      { detail: 'Not Found' },
      404,
      new Headers(),
      true,
    ) as any;

    expect(result.error).toBeDefined();
    expect(result.provider).toBe(AI21);
  });
});
