import { describe, expect, it } from 'vitest';
import ProviderConfigs from '../index';
import { chatCompleteParams } from '../open-ai-base';
import { OpenAIChatCompleteConfig } from '../openai/chatComplete';
import { transformUsingProviderConfig } from '../../services/transformToProviderRequest';
import type { ProviderConfig } from '../types';
import type { Params } from '../../types/requestBody';

const modelSentBy = (provider: string) =>
  transformUsingProviderConfig(
    (ProviderConfigs as any)[provider].chatComplete as ProviderConfig,
    {
      messages: [{ role: 'user', content: 'hi' }],
    } as Params,
  ).model;

describe('a default one provider names', () => {
  // The shared config was copied one level deep, so each parameter was still the
  // very object OpenAI's own config held. Writing a default into it named that
  // default for every provider built on the base — and whichever loaded last
  // won, which is how a request to OpenAI came to carry a model from Zhipu.
  it('is not named for the others', () => {
    const before = (OpenAIChatCompleteConfig as any).model.default;

    const named = chatCompleteParams([], { model: 'a-model-of-its-own' });
    const unnamed = chatCompleteParams([]);

    expect((named as any).model.default).toBe('a-model-of-its-own');
    expect((unnamed as any).model.default).toBe(before);
    expect((OpenAIChatCompleteConfig as any).model.default).toBe(before);
  });

  it('is not named for the config it was copied from', () => {
    const before = (OpenAIChatCompleteConfig as any).max_tokens?.default;

    chatCompleteParams([], { max_tokens: 4242 });

    expect((OpenAIChatCompleteConfig as any).max_tokens?.default).toBe(before);
  });

  it('leaves each provider sending the model it chose', () => {
    // The providers that name one, and one that names none.
    expect(modelSentBy('z-ai')).toBe('glm-4.6');
    expect(modelSentBy('nebius')).toBe('Qwen/Qwen2.5-72B-Instruct-fast');
    expect(modelSentBy('requesty')).toBe('openai/gpt-4o-mini');
    expect(modelSentBy('openai')).toBe('gpt-3.5-turbo');
  });

  it('leaves a request that names its own model alone', () => {
    const request = transformUsingProviderConfig(
      (ProviderConfigs as any)['z-ai'].chatComplete as ProviderConfig,
      { model: 'glm-4.5-air', messages: [{ role: 'user', content: 'hi' }] } as Params,
    );

    expect(request.model).toBe('glm-4.5-air');
  });
});
