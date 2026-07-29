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
          // LinkedErrors has already expanded `error.cause` into extra entries
          // by this point and marked each one `chained`; overwriting those too
          // would erase the very cause text this call site wants Sentry to keep.
          // A lone exception carries mechanism type `generic`, so this is a
          // no-op change for every call site that isn't reporting a cause chain.
          if (exception.mechanism?.type !== 'chained') {
            exception.value = message;
          }
        }
      }

      return event;
    });

    const scopeContext = {
      extra: {
        originalMessage: message,
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
