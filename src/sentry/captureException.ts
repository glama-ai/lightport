import { logger } from '../logger';
import type { Extras, ScopeContext, SeverityLevel } from '@sentry/core';
import { captureException as captureSentryException, withScope } from '@sentry/node-core/light';

const MAX_CAUSE_DEPTH = 5;

/**
 * LinkedErrors truncates at 5 levels (`@sentry/core`'s own default `limit`),
 * silently dropping anything deeper from `event.exception.values`. This walks
 * `.cause` independently so a chain that hits that ceiling still leaves its
 * tail somewhere in the event.
 */
const serializeCauseChain = (error: unknown): Array<{ code?: string; message: string; name: string }> => {
  const chain: Array<{ code?: string; message: string; name: string }> = [];
  let cause = error instanceof Error ? error.cause : undefined;

  while (cause instanceof Error && chain.length < MAX_CAUSE_DEPTH) {
    const code = (cause as { code?: unknown }).code;

    chain.push({
      ...(typeof code === 'string' && { code }),
      message: cause.message,
      name: cause.name,
    });

    cause = cause.cause;
  }

  return chain;
};

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

    const causeChain = serializeCauseChain(error);

    const scopeContext = {
      extra: {
        originalMessage: error instanceof Error ? error.message : String(error),
        ...(causeChain.length > 0 && { causeChain }),
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
