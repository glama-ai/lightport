import { logger } from '../logger';
import type { Extras, ScopeContext, SeverityLevel } from '@sentry/core';
import { captureException as captureSentryException, withScope } from '@sentry/node-core/light';

export const captureException = ({
  error,
  extra,
  message,
  level,
  tags,
}: {
  error: unknown;
  extra?: Extras;
  level?: SeverityLevel;
  message: string;
  tags?: Record<string, string>;
}): string => {
  return withScope((scope) => {
    scope.addEventProcessor((event) => {
      if (event.exception?.values) {
        for (const exception of event.exception.values) {
          exception.value = message;
        }
      }

      return event;
    });

    const scopeContext = {
      extra: {
        ...extra,
      },
      level,
      tags,
    } as Partial<ScopeContext> & { extra: Extras };

    const sentryId = captureSentryException(error, scopeContext);

    logger.warn({ sentryId }, 'capturing exception: %s', message);

    return sentryId;
  });
};
