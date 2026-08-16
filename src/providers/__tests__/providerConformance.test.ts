import { describe, expect, it } from 'vitest';
import { VALID_PROVIDERS } from '../../globals';
import { transformUsingProviderConfig } from '../../services/transformToProviderRequest';
import type { Params } from '../../types/requestBody';
import Providers from '..';
import type { ProviderConfig } from '../types';

/**
 * What holds for every provider, checked against every provider.
 *
 * The guardrails here were each written for the one provider that broke them,
 * and a provider added afterwards is simply absent from them. Read from the
 * registry instead, so a new provider is covered by being registered rather
 * than by someone remembering to list it.
 *
 * Where a rule does not hold yet, the providers it does not hold for are named
 * below rather than the rule being softened. Emptying a list is the work; the
 * list is what says how much of it is left.
 */
const registered = Object.keys(Providers);

const chatConfigOf = (name: string) => (Providers as Record<string, any>)[name]?.chatComplete;

const modelSentBy = (name: string) => {
  const config = chatConfigOf(name);
  if (!config) return undefined;

  try {
    return transformUsingProviderConfig(config as ProviderConfig, {
      messages: [{ role: 'user', content: 'hi' }],
    } as Params).model;
  } catch {
    // A provider whose config demands options a bare call cannot supply. It is
    // not sending OpenAI's model either way.
    return undefined;
  }
};

describe('every registered provider', () => {
  it('is registered under the name it is asked for', () => {
    expect(registered.length).toBeGreaterThan(70);
  });

  // Registering a provider without allowlisting it leaves it unreachable: the
  // header is refused before anything else happens.
  const UNREACHABLE = [
    'qdrant',
    'milvus',
    'replicate',
    'bytez',
    '302ai',
    'cometapi',
    'matterai',
    'meshy',
    'nextbit',
    'tripo3d',
    'z-ai',
  ];

  it('is one a caller is allowed to name', () => {
    const unreachable = registered.filter((name) => !VALID_PROVIDERS.includes(name));

    // Pinned rather than asserted empty: each of these is reachable the moment
    // it is added to `VALID_PROVIDERS`, so removing a name from this list is a
    // decision to publish that provider rather than a tidy-up.
    expect(unreachable.sort()).toEqual([...UNREACHABLE].sort());
  });

  /**
   * Providers still sending OpenAI's model when the caller names none.
   *
   * `chatCompleteParams` copies OpenAI's own config, `gpt-3.5-turbo` included,
   * so a provider that names no default sends a model it cannot route and
   * answers a question nobody asked. Each name here is a provider that has not
   * been converted yet.
   */
  const SENDS_OPENAIS_MODEL = [
    'groq',
    'deepbricks',
    'cerebras',
    'nscale',
    'hyperbolic',
    '302ai',
    'cometapi',
    'modal',
    'iointelligence',
    'aibadgr',
    'databricks',
  ];

  it('sends a model of its own, or none', () => {
    const leaking = registered.filter(
      (name) => name !== 'openai' && modelSentBy(name) === 'gpt-3.5-turbo',
    );

    expect(leaking.sort()).toEqual([...SENDS_OPENAIS_MODEL].sort());
  });

  it('leaves OpenAI sending its own model', () => {
    // The canary for the copy-depth fix in `chatCompleteParams`: whichever
    // provider wrote a default into the shared object wrote it for OpenAI too.
    expect(modelSentBy('openai')).toBe('gpt-3.5-turbo');
  });

  it('holds its own parameter configs, sharing none with another provider', () => {
    const owner = new Map<object, string>();
    const shared: string[] = [];

    for (const name of registered) {
      const provider = (Providers as Record<string, any>)[name];

      for (const endpoint of ['chatComplete', 'complete', 'embed', 'imageGenerate']) {
        const config = provider?.[endpoint];
        if (!config || typeof config !== 'object') continue;

        const held = owner.get(config);
        // Two providers holding one object is how a default written for either
        // one was written for both — and for OpenAI, whose object it is.
        if (held) shared.push(`${name}.${endpoint} is ${held}`);
        else owner.set(config, `${name}.${endpoint}`);
      }
    }

    expect(shared).toEqual(['cometapi.embed is openai.embed']);
  });
});
