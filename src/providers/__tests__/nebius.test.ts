import { describe, expect, it } from 'vitest';
import { transformUsingProviderConfig } from '../../services/transformToProviderRequest';
import type { Options, Params } from '../../types/requestBody';
import ProviderConfigs from '../index';
import type { ProviderConfig } from '../types';

const nebius = (ProviderConfigs as any).nebius;

describe('nebius', () => {
  it.each([
    ['chatComplete', 'https://api.tokenfactory.nebius.com/v1/chat/completions'],
    ['complete', 'https://api.tokenfactory.nebius.com/v1/completions'],
  ])('is addressed at token factory for %s', (fn, address) => {
    const providerOptions = { apiKey: 'test-key' } as Options;

    expect(
      nebius.api.getBaseURL({ providerOptions }) + nebius.api.getEndpoint({ fn, providerOptions }),
    ).toBe(address);
  });

  // The models it defaulted to are gone from Token Factory's catalog.
  it.each(['chatComplete', 'complete'])('sends no model the caller did not name for %s', (fn) => {
    const request = transformUsingProviderConfig(
      nebius[fn] as ProviderConfig,
      {
        messages: [{ content: 'hi', role: 'user' }],
        prompt: 'hi',
      } as unknown as Params,
    );

    expect(request.model).toBeUndefined();
  });
});
