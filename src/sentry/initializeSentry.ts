import { Environment } from '../utils/env';
import { createEventRateLimiter } from './createEventRateLimiter';
import { scrubSensitiveData } from './scrubSensitiveData';
import * as Sentry from '@sentry/node-core/light';

const sentryEventRateLimiter = createEventRateLimiter({
  globalMaxPerWindow: 50,
  maxPerWindow: 10,
  windowMs: 60_000,
});

export const initializeSentry = () => {
  const env = Environment({});

  if (!env.SENTRY_DSN) {
    return;
  }

  Sentry.init({
    attachStacktrace: true,
    // The last point at which anything can be kept out of Sentry: server-side
    // scrubbing only runs once the event has already crossed the network.
    beforeSend: (event, hint) => {
      const retained = sentryEventRateLimiter(event, hint);

      if (!retained) {
        return null;
      }

      return scrubSensitiveData(retained);
    },
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    initialScope: {
      tags: {
        service: env.SERVICE_NAME,
      },
    },
    integrations: (integrations) => {
      return [
        ...integrations,
        // This lifts every non-standard property off a captured Error and walks
        // it to `depth`, and gateway errors wrap the request state that produced
        // them — a messages array, tools, provider options. Walking that to 5
        // costs a third of the price of a capture, and the levels it buys are
        // the insides of individual messages rather than the shape of the
        // request. What it normalizes is exempt from `normalizeDepth` below, so
        // this is the only depth that governs it.
        Sentry.extraErrorDataIntegration({
          captureErrorCause: true,
          depth: 3,
        }),
        // Request bodies carry prompts and provider credentials; keep them out
        // of Sentry entirely rather than relying on downstream scrubbing.
        //
        // Breadcrumbs here cover outgoing `node:http` requests only, and the
        // gateway makes none: every provider call goes out through undici's
        // fetch, which `nativeNodeFetchIntegration` below still records. This
        // buys nothing on Node 24, which is what we ship — the listener pair it
        // avoids is only installed below 22.12 — but it stops a whole class of
        // instrumentation from waking up for traffic this process never sends.
        Sentry.httpIntegration({
          breadcrumbs: false,
          maxRequestBodySize: 'none',
        }),
        // Provider requests go out through undici's fetch, which this integration
        // decorates with `sentry-trace` and `baggage` headers by default. Nothing
        // downstream reads them — no provider is in our trace — and they carry the
        // Sentry public key and environment name to all 85+ of them. Breadcrumbs
        // are kept: those stay in the process until an exception is captured.
        Sentry.nativeNodeFetchIntegration({
          tracePropagation: false,
        }),
      ];
    },
    maxBreadcrumbs: 20,
    maxValueLength: 50_000,
    normalizeDepth: 8,
    sendDefaultPii: false,
    tracesSampleRate: 0,
  });
};
