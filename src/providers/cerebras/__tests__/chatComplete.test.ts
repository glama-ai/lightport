import { describe, expect, it } from 'vitest';
import { transformUsingProviderConfig } from '../../../services/transformToProviderRequest';
import type { Params } from '../../../types/requestBody';
import type { ProviderConfig } from '../../types';
import { cerebrasProviderAPIConfig } from '..';

describe('Cerebras chat completions', () => {
  it('forwards supported OpenAI-compatible parameters', () => {
    const sent = transformUsingProviderConfig(
      cerebrasProviderAPIConfig.chatComplete as ProviderConfig,
      {
        model: 'gpt-oss-120b',
        messages: [{ role: 'user', content: 'hello' }],
        frequency_penalty: 0.25,
        presence_penalty: -0.5,
        logit_bias: { '42': 1 },
        logprobs: true,
        parallel_tool_calls: false,
        service_tier: 'default',
      } as unknown as Params,
    );

    expect(sent).toMatchObject({
      frequency_penalty: 0.25,
      presence_penalty: -0.5,
      logit_bias: { '42': 1 },
      logprobs: true,
      parallel_tool_calls: false,
      service_tier: 'default',
    });
  });
});
