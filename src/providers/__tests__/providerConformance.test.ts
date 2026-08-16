import { describe, expect, it } from 'vitest';
import { supportsResponsesApiNatively } from '../../adapters/responses';
import { VALID_PROVIDERS } from '../valid';
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

  /**
   * Providers registered and deliberately not published.
   *
   * Registering one without allowlisting it left it unreachable — the header is
   * refused before anything else happens — and eleven had drifted that way with
   * nothing saying so. The allowed names are read from the registry now, so
   * this is the whole of the difference between the two.
   */
  const UNPUBLISHED = [
    '302ai',
    'bytez',
    'cometapi',
    'matterai',
    'meshy',
    'milvus',
    'nextbit',
    'qdrant',
    'replicate',
    'tripo3d',
    'z-ai',
  ];

  it('is one a caller is allowed to name, unless it is held back on purpose', () => {
    const unreachable = registered.filter((name) => !VALID_PROVIDERS.includes(name));

    expect(unreachable.sort()).toEqual([...UNPUBLISHED].sort());
  });

  it('is not allowed to be named without being registered', () => {
    // The other direction, which drifted too: the allowed names once held
    // `lightport` itself and providers the registry does not carry.
    const unregistered = VALID_PROVIDERS.filter(
      (name) => name !== 'lightport' && !registered.includes(name),
    );

    expect(unregistered).toEqual([]);
  });

  it('serves the Responses API itself only where it says it does', () => {
    // Read from the provider rather than from a second list kept beside it.
    for (const name of ['openai', 'azure-openai', 'openrouter', 'groq', 'x-ai']) {
      expect(supportsResponsesApiNatively(name)).toBe(true);
    }

    expect(supportsResponsesApiNatively('cerebras')).toBe(false);
  });

  /**
   * Providers that write `gpt-3.5-turbo` into their own config.
   *
   * Not the same fault as inheriting it. `chatCompleteParams` copies OpenAI's
   * config wholesale, default included, so a provider that named nothing was
   * sending a model it could not route and nobody had chosen. These three named
   * it, and each resells OpenAI's own models, so it may well be routable. A
   * stated choice is theirs to revisit; a silent inheritance was not a choice at
   * all.
   */
  const NAMES_OPENAIS_MODEL = ['302ai', 'cometapi', 'deepbricks'];

  it('sends a model of its own, or none', () => {
    const sending = registered.filter(
      (name) => name !== 'openai' && modelSentBy(name) === 'gpt-3.5-turbo',
    );

    expect(sending.sort()).toEqual([...NAMES_OPENAIS_MODEL].sort());
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

    // Nothing is shared any more. Asserted empty rather than pinned, because a
    // provider that starts sharing one has reintroduced the fault rather than
    // inherited it.
    expect(shared).toEqual([]);
  });
});
