import { setTag } from '@sentry/node-core/light';

// Sentry truncates tag values at 200 characters and rejects newlines.
const MAX_TAG_VALUE_LENGTH = 200;

/**
 * Request attributes attached to Sentry events for triage.
 *
 * Most of these arrive from user-controlled headers and request bodies, so the
 * type is a closed allowlist and every value is coerced, collapsed and
 * truncated before it leaves the process. Nothing is ever spread in wholesale:
 * provider options carry API keys and private keys, and Sentry's server-side
 * scrubbing only runs after the data has already crossed the network.
 */
export type RequestTags = {
  adapted?: boolean;
  endpoint?: unknown;
  model?: unknown;
  provider?: unknown;
  route?: unknown;
  stream?: boolean;
  traceId?: unknown;
};

const TAG_KEYS: Record<keyof RequestTags, string> = {
  adapted: 'adapted',
  endpoint: 'endpoint',
  model: 'model',
  provider: 'provider',
  route: 'route',
  stream: 'stream',
  traceId: 'trace_id',
};

const toTagValue = (value: unknown): string | null => {
  if (typeof value === 'boolean') {
    return String(value);
  }

  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.replace(/\s+/g, ' ').trim();

  return normalized === '' ? null : normalized.slice(0, MAX_TAG_VALUE_LENGTH);
};

/**
 * Tags the current isolation scope, which `withRequestScope` forks per request.
 * Every `captureException` raised for the rest of that request inherits the
 * tags, including from stream callbacks that have no lexical access to the
 * request.
 *
 * Safe to call repeatedly to refine: `tryPost` overwrites the header-derived
 * provider with the one actually resolved from the config, which is the only
 * accurate value when a config carries `targets` and no provider header. Values
 * that resolve to nothing are skipped rather than cleared, so a later refinement
 * never blanks out what an earlier call established.
 */
export const setRequestTags = (tags: RequestTags): void => {
  for (const key of Object.keys(tags) as Array<keyof RequestTags>) {
    const tagValue = toTagValue(tags[key]);

    if (tagValue !== null) {
      setTag(TAG_KEYS[key], tagValue);
    }
  }
};
