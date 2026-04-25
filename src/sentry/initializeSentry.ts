import { Environment } from '../utils/env';
import { createEventRateLimiter } from './createEventRateLimiter';
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
    beforeSend: sentryEventRateLimiter,
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
      ];
    },
    maxBreadcrumbs: 20,
    maxValueLength: 50_000,
    normalizeDepth: 8,
    sendDefaultPii: false,
    tracesSampleRate: 0,
  });
};
