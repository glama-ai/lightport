import { describe, expect, it } from 'vitest';
import ProviderConfigs from '../index';
import { transformUsingProviderConfig } from '../../services/transformToProviderRequest';
import { getStreamModeSplitPattern } from '../../utils';
import type { ProviderConfig } from '../types';
import type { Params, Options } from '../../types/requestBody';

// The providers whose text-completion endpoint is published. Adding one here
// means its `/completions` was checked against the provider's own reference, not
// assumed from the endpoint being OpenAI-shaped.
//
// The whole address rather than the path, because which half the version
// segment sits in is not the provider's contract with the caller — the address
// the request arrives at is. A provider that moves `/v1` out of its base URL,
// so that a custom host cannot drop it, must still answer at the same place.
const providers = [
  ['cerebras', 'https://api.cerebras.ai/v1/completions'],
  ['hyperbolic', 'https://api.hyperbolic.xyz/v1/completions'],
  ['sambanova', 'https://api.sambanova.ai/v1/completions'],
  ['nscale', 'https://inference.api.nscale.com/v1/completions'],
] as const;

// What each provider does not take on `/completions`, and so must not be sent.
const excluded: Record<string, string[]> = {
  cerebras: ['frequency_penalty', 'presence_penalty', 'logit_bias', 'best_of', 'n', 'suffix'],
  hyperbolic: [],
  sambanova: ['presence_penalty', 'frequency_penalty', 'user', 'logprobs'],
  nscale: ['user'],
};

// Every parameter a caller might send, so that anything not excluded is proven
// to survive rather than being quietly dropped.
const everyParam: Params = {
  model: 'a-model',
  prompt: 'once upon a time',
  max_tokens: 32,
  temperature: 0.5,
  top_p: 0.9,
  n: 1,
  stream: false,
  logprobs: 3,
  echo: true,
  stop: ['\n'],
  presence_penalty: 0.1,
  frequency_penalty: 0.2,
  best_of: 1,
  logit_bias: { '1': 1 },
  user: 'someone',
  seed: 7,
  suffix: 'the end',
} as Params;

describe.each(providers)('%s text completions', (name, endpoint) => {
  const config = (ProviderConfigs as any)[name];

  it('is registered, so the route can reach it', () => {
    // `/v1/completions` is served, but a provider that names no `complete`
    // config cannot be routed to it however OpenAI-shaped it is.
    expect(config.complete).toBeDefined();
    expect(config.responseTransforms.complete).toBeTypeOf('function');
  });

  it('points at the provider’s own completions endpoint', () => {
    const base = config.api.getBaseURL({ providerOptions: {} as Options });
    const path = config.api.getEndpoint({ fn: 'complete', providerOptions: {} as Options });

    expect(`${base}${path}`).toBe(endpoint);
  });

  it('sends what the provider takes and holds back what it does not', () => {
    const request = transformUsingProviderConfig(config.complete as ProviderConfig, everyParam);

    // The prompt is the whole point of the endpoint.
    expect(request.prompt).toBe('once upon a time');

    for (const param of excluded[name]) {
      expect(request).not.toHaveProperty(param);
    }

    // Anything not excluded survives: dropping a parameter the provider accepts
    // would lose it with nothing to say it had gone.
    const dropped = Object.keys(everyParam).filter(
      (param) => !(param in request) && !excluded[name].includes(param),
    );
    expect(dropped).toEqual([]);
  });

  it('streams events a client can actually read', () => {
    // Whatever reaches the caller has to be SSE, which ends an event with a
    // blank line. A provider read on a single newline and handed on untouched
    // produces a body no parser will read — and no `[DONE]` either.
    const splitPattern = getStreamModeSplitPattern(name, `https://example/${endpoint}`);
    const transform = config.responseTransforms['stream-complete'];
    const event = `data: ${JSON.stringify({ id: 'c1', choices: [{ text: 'once', index: 0 }] })}`;

    const emitted = transform ? transform(event, 'fallback', {}, true) : event + splitPattern;

    expect(emitted.endsWith('\n\n')).toBe(true);
    expect(emitted).toContain('"text":"once"');
  });
});

describe('providers left out of the sweep', () => {
  it.each([
    // Documented as chat-only.
    'groq',
    // The route answers, but the parameters it takes are not published.
    'empiriolabs',
    // No published text-completion endpoint found.
    'dashscope',
    'upstage',
    'kluster-ai',
    'inference-net',
    'krutrim',
    'lemonfox-ai',
    'iointelligence',
    'aibadgr',
  ])('%s is not wired for text completions', (name) => {
    // Pinned so that adding one later is a deliberate act with a source behind
    // it, rather than something that drifts in because the provider looks
    // OpenAI-shaped. The provider is looked up without `?.` so that a rename
    // fails here rather than passing on a name that no longer exists.
    const config = (ProviderConfigs as any)[name];

    expect(config).toBeDefined();
    expect(config.complete).toBeUndefined();
  });
});
