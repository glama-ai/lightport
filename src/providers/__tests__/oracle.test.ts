import { describe, expect, it } from 'vitest';
import { transformUsingProviderConfig } from '../../services/transformToProviderRequest';
import type { Options, Params } from '../../types/requestBody';
import { OracleChatCompleteConfig } from '../oracle/chatComplete';

const chatRequest = (model: string, params: Record<string, unknown>) =>
  transformUsingProviderConfig(
    OracleChatCompleteConfig,
    { messages: [{ content: 'hi', role: 'user' }], model, ...params } as unknown as Params,
    { oracleCompartmentId: 'ocid1.compartment.oc1..test' } as Options,
  ).chatRequest;

describe('the limit oracle is sent', () => {
  // OCI refuses `maxTokens` for these, naming the other field.
  it.each([
    ['openai.gpt-5', 'max_tokens'],
    ['openai.gpt-5-mini', 'max_completion_tokens'],
    ['openai.o4-mini', 'max_completion_tokens'],
  ])('is maxCompletionTokens for %s given %s', (model, param) => {
    const request = chatRequest(model, { [param]: 200 });

    expect(request.maxCompletionTokens).toBe(200);
    expect(request).not.toHaveProperty('maxTokens');
  });

  it.each(['openai.gpt-4o', 'meta.llama-3.3-70b-instruct', 'xai.grok-3-mini'])(
    'is maxTokens for %s, as before',
    (model) => {
      const request = chatRequest(model, { max_tokens: 128 });

      expect(request.maxTokens).toBe(128);
      expect(request).not.toHaveProperty('maxCompletionTokens');
    },
  );

  it('is neither when no limit is asked for', () => {
    const request = chatRequest('openai.gpt-5', {});

    expect(request).not.toHaveProperty('maxTokens');
    expect(request).not.toHaveProperty('maxCompletionTokens');
  });
});
