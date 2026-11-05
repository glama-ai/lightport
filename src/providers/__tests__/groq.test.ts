import { describe, expect, it } from 'vitest';
import { transformUsingProviderConfig } from '../../services/transformToProviderRequest';
import type { Params } from '../../types/requestBody';
import ProviderConfigs from '../index';
import type { ProviderConfig } from '../types';

describe('what groq chat is sent', () => {
  // Groq names these as taken by none of its models.
  it('holds back the parameters groq does not take', () => {
    const request = transformUsingProviderConfig(
      (ProviderConfigs as any).groq.chatComplete as ProviderConfig,
      {
        logit_bias: { '1': 2 },
        logprobs: true,
        messages: [{ content: 'hi', role: 'user' }],
        model: 'llama-3.3-70b-versatile',
        top_logprobs: 2,
      } as unknown as Params,
    );

    expect(request).not.toHaveProperty('logit_bias');
    expect(request).not.toHaveProperty('logprobs');
    expect(request).not.toHaveProperty('top_logprobs');
  });
});
