import { describe, expect, it } from 'vitest';
import Providers from '..';
import { transformUsingProviderConfig } from '../../services/transformToProviderRequest';
import type { Options, Params } from '../../types/requestBody';
import type { ProviderConfig } from '../types';

const flexai = (Providers as Record<string, any>).flexai;

const url = (fn: string) =>
  `${flexai.api.getBaseURL({ providerOptions: {} as Options })}${flexai.api.getEndpoint({ fn, providerOptions: {} as Options })}`;

describe('flexai', () => {
  it('serves chat, text completions and embeddings from api.flex.ai', () => {
    expect(url('chatComplete')).toBe('https://api.flex.ai/v1/chat/completions');
    expect(url('complete')).toBe('https://api.flex.ai/v1/completions');
    expect(url('embed')).toBe('https://api.flex.ai/v1/embeddings');
  });

  it('holds back the one chat parameter FlexAI rejects, and forwards the ones it answers itself', () => {
    const request = transformUsingProviderConfig(
      flexai.chatComplete as ProviderConfig,
      {
        model: 'DeepSeek-V4-Flash-0731',
        messages: [{ role: 'user', content: 'hi' }],
        verbosity: 'low',
        n: 2,
        logit_bias: { '1': 1 },
      } as Params,
    );

    expect(request).not.toHaveProperty('verbosity');
    // FlexAI refuses n > 1 with a readable 400 and decides logit_bias per model;
    // both are the caller's to hear about rather than ours to drop.
    expect(request.n).toBe(2);
    expect(request.logit_bias).toEqual({ '1': 1 });
  });

  it('sends a real FlexAI model when the caller names none', () => {
    const chat = transformUsingProviderConfig(
      flexai.chatComplete as ProviderConfig,
      {
        messages: [{ role: 'user', content: 'hi' }],
      } as Params,
    );
    const embed = transformUsingProviderConfig(
      flexai.embed as ProviderConfig,
      { input: 'hi' } as Params,
    );

    expect(chat.model).toBe('DeepSeek-V4-Flash-0731');
    expect(embed.model).toBe('bge-m3');
  });

  it('does not send dimensions, which bge-m3 rejects', () => {
    const request = transformUsingProviderConfig(
      flexai.embed as ProviderConfig,
      {
        model: 'bge-m3',
        input: 'hi',
        dimensions: 256,
      } as Params,
    );

    expect(request).not.toHaveProperty('dimensions');
  });
});
