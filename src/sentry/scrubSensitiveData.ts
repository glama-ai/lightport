import type { ErrorEvent } from '@sentry/core';

const REDACTED = '[Redacted]';

// Guards against pathological nesting. The payload is already normalized and
// acyclic by the time beforeSend runs.
const MAX_DEPTH = 10;

/**
 * Derived from Sentry's own SENSITIVE_KEY_SNIPPETS, which it applies to headers,
 * cookies and query params but never to `contexts` or `extra`.
 *
 * `passphrase` and `serviceaccount` are added for credential fields particular
 * to this gateway (oracleKeyPassphrase, vertexServiceAccountJson). Sentry's
 * `csrf`, `xsrf`, `sid`, `identity` and `sso` are dropped: there is no cookie or
 * form surface here, the tokens they guard are already caught by `token`, and
 * the short ones match too many innocent words to be worth the lost context.
 */
const SENSITIVE_KEY_SNIPPETS = [
  'auth',
  'bearer',
  'cookie',
  'credential',
  'jwt',
  'key',
  'passphrase',
  'passwd',
  'password',
  'pwd',
  'saml',
  'secret',
  'serviceaccount',
  'session',
  'token',
];

// Separators are stripped so that snake_case and kebab-case spellings collapse
// onto the same snippets: private_key and x-api-key both have to match `key`.
const isSensitiveKey = (key: string): boolean => {
  const normalized = key.toLowerCase().replace(/[-_]/g, '');

  return SENSITIVE_KEY_SNIPPETS.some((snippet) => normalized.includes(snippet));
};

const scrubValue = (value: unknown, depth: number): unknown => {
  if (depth >= MAX_DEPTH || value === null || typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => scrubValue(item, depth + 1));
  }

  const scrubbed: Record<string, unknown> = {};

  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    scrubbed[key] = isSensitiveKey(key) ? REDACTED : scrubValue(nested, depth + 1);
  }

  return scrubbed;
};

/**
 * Redacts credential-bearing values from `contexts` and `extra` before an event
 * leaves the process.
 *
 * `extraErrorDataIntegration` lifts every non-standard enumerable property off a
 * captured Error into `contexts[ErrorName]` and applies no key filtering of its
 * own, so a gateway error that wraps the request state which produced it carries
 * API keys, AWS secrets and service account JSON straight to Sentry. Sentry's
 * own denylist never reaches those fields, and its server-side scrubbing only
 * runs after ingest — by which point the value has already crossed the network.
 *
 * Only key names are matched, and only within `contexts` and `extra`. A
 * credential interpolated into an error *message* still gets through: catching
 * that needs value-shape matching, which this deliberately does not attempt.
 */
export const scrubSensitiveData = (event: ErrorEvent): ErrorEvent => {
  if (event.contexts) {
    event.contexts = scrubValue(event.contexts, 0) as ErrorEvent['contexts'];
  }

  if (event.extra) {
    event.extra = scrubValue(event.extra, 0) as ErrorEvent['extra'];
  }

  return event;
};
