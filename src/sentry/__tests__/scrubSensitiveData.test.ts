import { captureException } from '../captureException';
import { scrubSensitiveData } from '../scrubSensitiveData';
import type { ErrorEvent } from '@sentry/core';
import * as Sentry from '@sentry/node-core/light';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

const events: ErrorEvent[] = [];

beforeAll(() => {
  Sentry.init({
    // Mirrors initializeSentry, so this exercises the real integration that
    // lifts non-standard properties off a captured Error, and scrubs at the same
    // point in the pipeline that production does.
    attachStacktrace: true,
    beforeSend: (event) => {
      events.push(scrubSensitiveData(event));
      return null;
    },
    dsn: 'https://public@example.invalid/1',
    integrations: (integrations) => {
      return [
        ...integrations,
        Sentry.extraErrorDataIntegration({
          captureErrorCause: true,
          depth: 5,
        }),
      ];
    },
    maxValueLength: 50_000,
    normalizeDepth: 8,
    sendDefaultPii: false,
    tracesSampleRate: 0,
  });
});

beforeEach(() => {
  events.length = 0;
});

const flush = async () => {
  await Sentry.flush(2_000);
};

/**
 * Only the regions the scrubber claims: `contexts` and `extra`.
 *
 * Deliberately not the whole event. `attachStacktrace` plus the ContextLines
 * integration embeds this file's own source in every event, and that source
 * contains these credential literals — an artifact of writing them here, not a
 * leak, since real credentials do not live in lightport's source.
 */
const scrubbedRegions = () => {
  return JSON.stringify({ contexts: events[0].contexts, extra: events[0].extra });
};

describe('credentials on captured errors', () => {
  it('does not reach Sentry when an error carries provider options', async () => {
    // The shape a gateway error takes when it wraps the request state that
    // produced it. Every one of these keys is real, from constructConfigFromRequestHeaders.
    const error = Object.assign(new Error('provider request failed'), {
      providerOptions: {
        api_key: 'sk-live-LEAKED-OPENAI-KEY',
        awsSecretAccessKey: 'LEAKED-AWS-SECRET',
        azureEntraClientSecret: 'LEAKED-AZURE-SECRET',
        provider: 'bedrock',
        vertexServiceAccountJson: { client_email: 'x@y.com', private_key: 'LEAKED-VERTEX-KEY' },
      },
    });

    captureException({ error, message: 'provider request failed' });

    await flush();

    const serialized = scrubbedRegions();

    expect(serialized).not.toContain('LEAKED-OPENAI-KEY');
    expect(serialized).not.toContain('LEAKED-AWS-SECRET');
    expect(serialized).not.toContain('LEAKED-AZURE-SECRET');
    expect(serialized).not.toContain('LEAKED-VERTEX-KEY');
  });

  it('keeps the surrounding context that makes the error worth reporting', async () => {
    const error = Object.assign(new Error('provider request failed'), {
      providerOptions: { api_key: 'sk-live-LEAKED', provider: 'bedrock' },
      statusCode: 429,
    });

    captureException({ error, message: 'provider request failed' });

    await flush();

    const serialized = scrubbedRegions();

    expect(serialized).toContain('bedrock');
    expect(serialized).toContain('429');
    expect(serialized).not.toContain('sk-live-LEAKED');
  });

  it('does not reach Sentry through a non-Error cause, which is attached raw', async () => {
    const error = new Error('provider request failed', {
      cause: { authorization: 'Bearer sk-live-LEAKED-VIA-CAUSE' },
    });

    captureException({ error, message: 'provider request failed' });

    await flush();

    expect(scrubbedRegions()).not.toContain('LEAKED-VIA-CAUSE');
  });

  it('does not reach Sentry through extra passed at the call site', async () => {
    captureException({
      error: new Error('boom'),
      extra: { requestHeaders: { authorization: 'Bearer sk-live-LEAKED-VIA-EXTRA' } },
      message: 'boom',
    });

    await flush();

    expect(scrubbedRegions()).not.toContain('LEAKED-VIA-EXTRA');
  });

  it('reaches credentials nested below a key that is not itself sensitive', async () => {
    const error = Object.assign(new Error('boom'), {
      // `targets` names nothing sensitive, so only recursion catches what is
      // underneath it.
      targets: [{ api_key: 'sk-live-LEAKED-NESTED', provider: 'openai' }],
    });

    captureException({ error, message: 'boom' });

    await flush();

    expect(scrubbedRegions()).not.toContain('LEAKED-NESTED');
  });

  it('leaves the trace context Sentry relies on intact', async () => {
    captureException({ error: new Error('boom'), message: 'boom' });

    await flush();

    // Over-broad key matching here would sever error-to-trace correlation.
    expect(events[0].contexts?.trace?.trace_id).toMatch(/^[a-f0-9]{32}$/);
    expect(events[0].contexts?.runtime?.name).toBe('node');
  });
});
