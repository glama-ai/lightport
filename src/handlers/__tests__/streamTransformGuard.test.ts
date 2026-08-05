import { readOpenAiErrorEvent } from '../../errors/openAiError';
import Providers from '../../providers';
import { guardStreamTransform } from '../streamTransformGuard';
import { describe, expect, it } from 'vitest';

/**
 * A mid-stream failure as an OpenAI-compatible upstream reports one.
 *
 * Most of the catalogue registers no transform of its own, so this arrives at
 * the gateway exactly as written — and the transforms that do exist are written
 * against the shape of a completion.
 */
const errorChunk = 'data: {"error":{"message":"rate limit exceeded","type":"rate_limit_error"}}';

const contentChunk =
  'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m",' +
  '"choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}';

/**
 * Models named only to make a provider commit to a transform.
 *
 * `vertex-ai` and `bedrock` register nothing statically and choose per model
 * family in `getConfig`, returning no transform at all for a request that names
 * no model. Read from `responseTransforms` alone, the two hairiest stream paths
 * in the gateway are absent from the table below and nothing says so.
 */
const PROBE_MODELS = ['gemini-1.5-pro', 'meta/llama3-405b-instruct-maas'];

/** Both endpoints reach `handleStreamingMode`, so the guard wraps both. */
const STREAM_TRANSFORM_KEYS = ['stream-chatComplete', 'stream-complete'];

const transformsFor = (config: any): Record<string, unknown> => {
  const fromGetConfig = PROBE_MODELS.map((model) => {
    try {
      return config?.getConfig?.({ params: { model }, providerOptions: {} })?.responseTransforms;
    } catch {
      // A provider free to demand more of its options than a probe can supply.
      // It keeps whatever it registered statically.
      return undefined;
    }
  });

  return Object.assign({}, config?.responseTransforms, ...fromGetConfig);
};

/** Every stream transform the guard wraps, labelled by where it came from. */
const streamTransforms = Object.entries(Providers).flatMap(([provider, config]) => {
  const transforms = transformsFor(config);

  return STREAM_TRANSFORM_KEYS.filter((key) => typeof transforms[key] === 'function').map(
    (key) => [`${provider} ${key}`, transforms[key] as Function] as const,
  );
});

describe('guardStreamTransform', () => {
  it('covers every registered stream transform', () => {
    // Guards the guard. A count alone let the table lose `vertex-ai` and
    // `bedrock` — 30 static providers clear any threshold worth setting, so the
    // absent ones were the only thing it could not notice. Named instead, since
    // being named is the whole reason they are here.
    const labels = streamTransforms.map(([label]) => label);

    expect(labels).toEqual(
      expect.arrayContaining([
        'vertex-ai stream-chatComplete',
        'bedrock stream-chatComplete',
        'anthropic stream-complete',
        'deepinfra stream-chatComplete',
      ]),
    );
  });

  // The point of the table. A provider transform that throws on its own
  // upstream's error frame turns "the model refused" into "the connection
  // broke" — and the caller's next move depends on telling those apart. Adding
  // a provider that reintroduces it fails here rather than in production.
  it.each(streamTransforms)('%s delivers an upstream error as an error', (provider, transform) => {
    const guarded = guardStreamTransform(transform as Function, provider);

    const out = guarded(errorChunk, 'fallback-id', {}, true, {} as any);

    expect(typeof out).toBe('string');

    const recovered = readOpenAiErrorEvent((out as string).trim());

    expect(recovered?.message).toContain('rate limit exceeded');
  });

  it.each(streamTransforms)(
    '%s is left alone on a chunk that is not a failure',
    (provider, transform) => {
      // The overcorrection guard: a wrapper that answered everything with an
      // error frame would satisfy the table above and break every stream. Asserted
      // as "identical to what the bare transform did", so it holds for the
      // providers whose wire format is their own and who make nothing of an
      // OpenAI-shaped chunk either way.
      // Some transforms mint an id per call, so what is compared is the shape
      // rather than the bytes.
      const stable = (run: () => unknown) => {
        try {
          return (JSON.stringify(run()) ?? 'undefined')
            .replaceAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>')
            .replaceAll(/"created":\d+/g, '"created":<t>');
        } catch (err) {
          return `threw:${(err as Error).message}`;
        }
      };

      const bare = stable(() => transform(contentChunk, 'fallback-id', {}, true, {} as any));
      const guarded = stable(() =>
        guardStreamTransform(transform as Function, provider)(
          contentChunk,
          'fallback-id',
          {},
          true,
          {} as any,
        ),
      );

      expect(guarded).toBe(bare);
    },
  );

  it('lets a transform that reads its own error frame answer for itself', () => {
    // Anthropic's maps the type and names the provider. Pre-empting a transform
    // that handles the case would replace something specific with something
    // blunter, so the transform runs first and its answer wins.
    const specific = () =>
      'event: error\ndata: {"error":{"message":"anthropic error: Overloaded","type":"overloaded_error"}}\n\n';

    const out = guardStreamTransform(specific, 'anthropic')(errorChunk) as string;

    expect(readOpenAiErrorEvent(out.trim())).toMatchObject({
      message: 'anthropic error: Overloaded',
      type: 'overloaded_error',
    });
  });

  it('recovers the whole failure, not the part of it that reads like prose', () => {
    // `code` is what a client dispatches on: `insufficient_quota` and
    // `context_length_exceeded` want different handling, and telling them apart
    // by parsing the message is not something a caller should have to do. A
    // recovery that kept only the message and the type would answer the
    // streamed request with less than `generateErrorResponse` answers the
    // unstreamed one — which is the parity this exists to hold.
    const detailed =
      'data: {"error":{"message":"quota","type":"insufficient_quota",' +
      '"param":"model","code":"insufficient_quota"}}';

    const out = guardStreamTransform(() => undefined, 'openai')(detailed) as string;

    expect(readOpenAiErrorEvent(out.trim())).toMatchObject({
      code: 'insufficient_quota',
      message: 'openai error: quota',
      param: 'model',
      type: 'insufficient_quota',
    });
  });

  it('recovers the failure when a transform drops it instead of throwing', () => {
    // Dropped, the stream runs on to its `[DONE]` and reports a completion the
    // model never gave — the same wrong answer, by a quieter route.
    const drops = () => undefined;

    const out = guardStreamTransform(drops, 'somewhere')(errorChunk) as string;

    expect(readOpenAiErrorEvent(out.trim())?.message).toBe('somewhere error: rate limit exceeded');
  });

  it('still lets a genuine transform fault stop the stream', () => {
    // A transform that cannot read ordinary content is broken, and there is
    // nothing to salvage from the rest of the stream. Swallowing that would
    // hand the caller a body that quietly goes wrong from here on.
    const broken = () => {
      throw new Error('boom');
    };

    expect(() => guardStreamTransform(broken, 'somewhere')(contentChunk)).toThrow('boom');
  });

  it('leaves a keep-alive alone', () => {
    const skips = () => undefined;

    expect(guardStreamTransform(skips, 'somewhere')(': ping')).toBeUndefined();
  });
});
