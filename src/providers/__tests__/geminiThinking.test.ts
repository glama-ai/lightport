import { describe, expect, it } from 'vitest';
import { transformGenerationConfig } from '../google-vertex-ai/transformGenerationConfig';
import { GoogleChatCompleteConfig } from '../google/chatComplete';
import { transformUsingProviderConfig } from '../../services/transformToProviderRequest';
import type { ProviderConfig } from '../types';
import type { Params } from '../../types/requestBody';

// The same mapping is reached two ways, and both are checked: through Vertex's
// generation config directly, and through the Google provider's request config,
// which is where the second copy of this logic used to live.
const configFor = (params: Record<string, unknown>) => ({
  vertex: transformGenerationConfig({ model: 'm', ...params } as any),
  google: transformUsingProviderConfig(
    GoogleChatCompleteConfig as ProviderConfig,
    {
      messages: [{ role: 'user', content: 'hi' }],
      ...params,
    } as Params,
  ).generationConfig,
});

const both = (params: Record<string, unknown>) => Object.values(configFor(params));

describe('the field a reasoning effort is sent under', () => {
  it('is a budget for Gemini 2.5, which does not take a level', () => {
    for (const config of both({ model: 'gemini-2.5-flash', reasoning_effort: 'high' })) {
      expect(config.thinking_config).toEqual({ include_thoughts: true, thinking_budget: 24576 });
      expect(config).not.toHaveProperty('thinkingConfig');
    }
  });

  it('is a level for Gemini 3, which is what it reads', () => {
    for (const config of both({ model: 'gemini-3-pro-preview', reasoning_effort: 'high' })) {
      expect(config.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: 'high' });
      expect(config).not.toHaveProperty('thinking_config');
    }
  });

  it('is a level for versions after 3 as well', () => {
    for (const config of both({ model: 'gemini-4-pro', reasoning_effort: 'low' })) {
      expect(config.thinkingConfig).toMatchObject({ thinkingLevel: 'low' });
    }
  });

  it('is a budget for a model that cannot be placed', () => {
    // The `latest` aliases name no version, and the legacy names none either.
    // Both are guesses, but a budget is the one Gemini 3 tolerates where a level
    // is the one 2.5 refuses — so the unplaceable model gets a budget.
    for (const model of ['gemini-flash-latest', 'gemini-pro', 'gemini-2.0-flash', undefined]) {
      for (const config of both({ model, reasoning_effort: 'medium' })) {
        expect(config.thinking_config).toEqual({ include_thoughts: true, thinking_budget: 8192 });
        expect(config).not.toHaveProperty('thinkingConfig');
      }
    }
  });

  it('is a budget for a number of tokens even on Gemini 3, which has no level for it', () => {
    for (const config of both({ model: 'gemini-3-pro-preview', reasoning_effort: '2048' })) {
      expect(config.thinking_config).toEqual({ include_thoughts: true, thinking_budget: 2048 });
      expect(config).not.toHaveProperty('thinkingConfig');
    }
  });
});

describe('asking for no reasoning', () => {
  it('turns thinking off on a model that thinks by default', () => {
    // 2.5 Flash and Pro both think unless told not to, and a budget of zero is
    // the only way to say so. Saying nothing left them thinking.
    for (const config of both({ model: 'gemini-2.5-flash', reasoning_effort: 'none' })) {
      expect(config.thinking_config).toEqual({ include_thoughts: false, thinking_budget: 0 });
    }
  });

  it('says nothing to a model that cannot be stopped', () => {
    // Google is explicit that reasoning cannot be turned off for 2.5 Pro or for
    // Gemini 3, and 2.5 Pro will not take a budget below 128. Sending the zero
    // anyway would fail a request that used to be served.
    for (const model of [
      'gemini-2.5-pro',
      'gemini-3-pro-preview',
      'gemini-2.0-flash',
      'gemini-flash-latest',
      undefined,
    ]) {
      for (const config of both({ model, reasoning_effort: 'none' })) {
        expect(config).not.toHaveProperty('thinkingConfig');
        expect(config).not.toHaveProperty('thinking_config');
      }
    }
  });
});

describe('an effort given as a number of tokens', () => {
  it('is the budget that was asked for', () => {
    // The effort a caller may send is not limited to the named ones. An unnamed
    // effort used to fall to the medium budget, so the number asked for was
    // replaced by a different one without a word.
    for (const config of both({ model: 'gemini-2.5-pro', reasoning_effort: '2048' })) {
      expect(config.thinking_config).toEqual({ include_thoughts: true, thinking_budget: 2048 });
    }
  });

  it('is nothing at all when it is neither a name nor a number', () => {
    // Including the names every object carries, which a plain lookup would have
    // found something for.
    for (const effort of ['vigorous', '__proto__', 'constructor', 'toString']) {
      for (const config of both({ model: 'gemini-2.5-pro', reasoning_effort: effort })) {
        expect(config).not.toHaveProperty('thinking_config');
        expect(config).not.toHaveProperty('thinkingConfig');
      }
    }
  });
});

describe('a request carrying both a thinking block and an effort', () => {
  it('is sent one thinking config, not two', () => {
    // Gemini refuses a request naming both, and the two are written under
    // different keys, so the earlier one has to go rather than sit beside it.
    for (const config of both({
      model: 'gemini-3-pro-preview',
      thinking: { type: 'enabled', budget_tokens: 5000 },
      reasoning_effort: 'high',
    })) {
      expect(config).not.toHaveProperty('thinking_config');
      expect(config.thinkingConfig).toMatchObject({ thinkingLevel: 'high' });
    }
  });

  it('keeps the thinking block when the effort says nothing the model can act on', () => {
    // An effort the model has no way to express leaves the block alone rather
    // than clearing it and putting nothing in its place.
    for (const config of both({
      model: 'gemini-2.5-pro',
      thinking: { type: 'enabled', budget_tokens: 5000 },
      reasoning_effort: 'none',
    })) {
      expect(config.thinking_config).toEqual({ include_thoughts: true, thinking_budget: 5000 });
    }
  });

  it('keeps the thinking block when no effort was asked for', () => {
    for (const config of both({
      model: 'gemini-3-pro-preview',
      thinking: { type: 'enabled', budget_tokens: 5000 },
    })) {
      expect(config.thinking_config).toEqual({ include_thoughts: true, thinking_budget: 5000 });
    }
  });
});
