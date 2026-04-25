import { logger } from '../logger';
import type { ErrorEvent, EventHint } from '@sentry/core';

type BucketState = {
  count: number;
  warningLogged: boolean;
  windowStart: number;
};

const MAX_KEY_COUNT = 100;
const MAX_MESSAGE_LENGTH = 100;

const deriveGroupingKey = (event: ErrorEvent): string => {
  const exception = event.exception?.values?.[0];

  if (!exception) {
    return 'unknown';
  }

  const errorType = exception.type ?? 'Error';
  const message = (exception.value ?? '').slice(0, MAX_MESSAGE_LENGTH);

  return `${errorType}:${message}`;
};

export const createEventRateLimiter = ({
  globalMaxPerWindow,
  maxPerWindow,
  windowMs,
}: {
  globalMaxPerWindow: number;
  maxPerWindow: number;
  windowMs: number;
}) => {
  const buckets = new Map<string, BucketState>();

  let globalCount = 0;
  let globalWarningLogged = false;
  let globalWindowStart = Date.now();

  const resetBucketIfStale = (bucket: BucketState, now: number): BucketState => {
    if (now - bucket.windowStart >= windowMs) {
      bucket.count = 0;
      bucket.warningLogged = false;
      bucket.windowStart = now;
    }

    return bucket;
  };

  const pruneStaleEntries = (now: number) => {
    if (buckets.size <= MAX_KEY_COUNT) {
      return;
    }

    for (const [key, bucket] of buckets) {
      if (now - bucket.windowStart >= windowMs) {
        buckets.delete(key);
      }
    }
  };

  return (
    event: ErrorEvent,
    _hint: EventHint,
  ): ErrorEvent | null | PromiseLike<ErrorEvent | null> => {
    const now = Date.now();

    if (now - globalWindowStart >= windowMs) {
      globalCount = 0;
      globalWarningLogged = false;
      globalWindowStart = now;
    }

    if (globalCount >= globalMaxPerWindow) {
      if (!globalWarningLogged) {
        logger.warn(
          { limit: globalMaxPerWindow, windowMs },
          'sentry rate limiter: global limit reached',
        );
        globalWarningLogged = true;
      }

      return null;
    }

    const key = deriveGroupingKey(event);

    let bucket = buckets.get(key);

    if (bucket) {
      resetBucketIfStale(bucket, now);
    } else {
      bucket = { count: 0, warningLogged: false, windowStart: now };
      buckets.set(key, bucket);
    }

    if (bucket.count >= maxPerWindow) {
      if (!bucket.warningLogged) {
        logger.warn(
          { key, limit: maxPerWindow, windowMs },
          'sentry rate limiter: per-key limit reached',
        );
        bucket.warningLogged = true;
      }

      return null;
    }

    bucket.count++;
    globalCount++;

    pruneStaleEntries(now);

    return event;
  };
};
