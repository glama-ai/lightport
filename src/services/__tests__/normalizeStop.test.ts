import { describe, expect, it } from 'vitest';
import transformToProviderRequest, { normalizeStopParam } from '../transformToProviderRequest';
import type { Options, Params } from '../../types/requestBody';

// OpenAI accepts `stop` as a string or string[]. Providers whose native field is
// an array of stop sequences reject a bare string with a 400. The gateway
// normalizes a single string to a one-element array once, in
// transformToProviderRequest, so every provider config is spared the concern.

describe('normalizeStopParam', () => {
  it('wraps a single string stop in an array', () => {
    expect(normalizeStopParam({ stop: '\n' } as Params).stop).toEqual(['\n']);
  });

  it('leaves an array stop unchanged', () => {
    expect(normalizeStopParam({ stop: ['\n', 'END'] } as Params).stop).toEqual(['\n', 'END']);
  });

  it('leaves an absent or null stop untouched', () => {
    expect(normalizeStopParam({} as Params).stop).toBeUndefined();
    expect(normalizeStopParam({ stop: null } as unknown as Params).stop).toBeNull();
  });

  it('does not mutate the input params', () => {
    const params = { stop: '\n' } as Params;
    normalizeStopParam(params);
    expect(params.stop).toBe('\n');
  });
});

describe('a single-string stop reaches array-only providers as an array', () => {
  const build = (provider: string, params: Partial<Params>) =>
    transformToProviderRequest(
      provider,
      params as Params,
      params as Params,
      'chatComplete',
      {},
      {} as Options,
    ) as Record<string, any>;

  it('anthropic maps it to a stop_sequences array', () => {
    expect(build('anthropic', { stop: '\n' }).stop_sequences).toEqual(['\n']);
  });

  it('cohere still arrays it after its per-provider coercion was removed', () => {
    expect(build('cohere', { stop: '\n' }).stop_sequences).toEqual(['\n']);
  });

  it('google (nested, imperative generationConfig) is covered too', () => {
    expect(build('google', { stop: '\n' }).generationConfig.stopSequences).toEqual(['\n']);
  });

  it('reka-ai still arrays it (stop_words) after its coercion was removed', () => {
    expect(build('reka-ai', { stop: '\n' }).stop_words).toEqual(['\n']);
  });

  it('an array stop is passed through unchanged', () => {
    expect(build('anthropic', { stop: ['\n', 'END'] }).stop_sequences).toEqual(['\n', 'END']);
  });
});
