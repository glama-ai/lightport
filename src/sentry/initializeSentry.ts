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
        Sentry.extraErrorDataIntegration({
          captureErrorCause: true,
          depth: 5,
        }),
        // Request bodies carry prompts and provider credentials; keep them out
        // of Sentry entirely rather than relying on downstream scrubbing.
        Sentry.httpIntegration({
          maxRequestBodySize: 'none',
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
