import { openAiErrorResponse } from '../../errors/openAiError';
import { CONTENT_TYPES, HEADER_KEYS, POWERED_BY } from '../../globals';
import { VALID_PROVIDERS } from '../../providers/valid';
import { logger } from '../../logger';
import { captureException } from '../../sentry/captureException';
import type { GatewayContext } from '../../types/GatewayContext';
import { parseJson } from '../../utils/parseJson';
import { configSchema, isValidCustomHost } from './schema/config';

/**
 * Everything rejected here is the caller's to fix, and they read it with an
 * OpenAI client. `invalid_request_error` at 400 is what that client raises on,
 * and the same envelope a provider error arrives in.
 */
const invalidRequest = (message: string): Response =>
  openAiErrorResponse({ message, type: 'invalid_request_error' }, 400);

/** Enough to fix the config by, far short of enough to fill a log with. */
const MAX_REPORTED_CONFIG_ISSUES = 10;
const MAX_MESSAGE_LENGTH = 2_000;

/**
 * Config naming a shape this gateway cannot route at all.
 *
 * `tryPost` calls one provider once, and there is no target resolution. A config
 * naming targets therefore never names a provider, and the request already dies
 * — on `Provider "" is not supported`, which names a provider the caller never
 * wrote and reads as though the provider list were the thing to go and fix.
 * Refusing takes away nothing that worked and replaces that with the true
 * reason.
 */
const UNROUTABLE_CONFIG = ['strategy', 'targets'] as const;

/**
 * Config that is read, validated, converted to camelCase and then dropped.
 *
 * There is no retry loop, no response cache, and nothing runs a hook or a
 * guardrail. An operator who sets `retry` believes they have retries, and finds
 * out during the incident the setting was for — which is worth saying, loudly
 * and in the log they will read afterwards. The guardrails are the same thing
 * and worse: someone who sets `output_guardrails` believes what the model says
 * is being screened before it reaches anyone, and nothing about the answer they
 * get back says otherwise.
 *
 * Said rather than enforced, because these requests succeed today. Refusing them
 * would trade a setting that quietly does nothing for a gateway that serves
 * nothing, at deploy time rather than at the incident, and it would land hardest
 * on whoever was careful enough to have configured retries in the first place.
 * A caller arriving from a gateway that did implement these — which is where
 * this config shape comes from — should not be met with an outage for it.
 *
 * `weight` and `on_status_codes` are deliberately absent from both lists. They
 * decorate a config rather than promise anything: standalone, with no strategy
 * to weigh and no fallback to trigger, `weight: 1` misleads nobody.
 */
const IGNORED_CONFIG = [
  'retry',
  'cache',
  'before_request_hooks',
  'after_request_hooks',
  'input_guardrails',
  'output_guardrails',
  // Named in a config, these are overwritten by the headers below before anyone
  // could read them — so they are dropped a step earlier than the rest, and just
  // as quietly.
  'default_input_guardrails',
  'default_output_guardrails',
] as const;

/**
 * Settings that arrive as headers of their own rather than inside the config.
 * They are read whether or not a config was sent, so a caller naming only these
 * would otherwise be told nothing at all — and the two guardrail headers are the
 * ones an operator is most likely to reach for, being how the defaults are set.
 */
const IGNORED_JSON_HEADERS = [
  `x-${POWERED_BY}-default-input-guardrails`,
  `x-${POWERED_BY}-default-output-guardrails`,
] as const;

const IGNORED_HEADERS = [...IGNORED_JSON_HEADERS, HEADER_KEYS.CACHE, HEADER_KEYS.RETRIES] as const;

const warnIgnored = (ignored: string[]) => {
  if (ignored.length === 0) return;

  logger.warn(
    { ignored },
    'request names behaviour this gateway does not implement and will not act on',
  );
};

const truncate = (message: string): string =>
  message.length > MAX_MESSAGE_LENGTH ? `${message.slice(0, MAX_MESSAGE_LENGTH)}…` : message;

export const requestValidator = (c: GatewayContext): Response | null => {
  const requestHeaders = c.get('mappedHeaders');

  const contentType = requestHeaders['content-type'];
  if (
    !!contentType &&
    ![CONTENT_TYPES.APPLICATION_JSON, CONTENT_TYPES.MULTIPART_FORM_DATA].includes(
      requestHeaders['content-type'].split(';')[0],
    ) &&
    !contentType.split(';')[0]?.startsWith(CONTENT_TYPES.GENERIC_AUDIO_PATTERN)
  ) {
    return invalidRequest('Invalid content type passed');
  }

  if (!(requestHeaders[`x-${POWERED_BY}-config`] || requestHeaders[`x-${POWERED_BY}-provider`])) {
    return invalidRequest(
      `Either x-${POWERED_BY}-config or x-${POWERED_BY}-provider header is required`,
    );
  }
  if (
    requestHeaders[`x-${POWERED_BY}-provider`] &&
    !VALID_PROVIDERS.includes(requestHeaders[`x-${POWERED_BY}-provider`])
  ) {
    return invalidRequest('Invalid provider passed');
  }

  const customHostHeader = requestHeaders[`x-${POWERED_BY}-custom-host`];
  if (customHostHeader && !isValidCustomHost(customHostHeader, c)) {
    return invalidRequest('Invalid custom host');
  }

  // Forwarding the forward-headers header itself would make every downstream hop
  // re-forward it, so a custom host pointing back at the gateway loops forever.
  const forwardHeadersHeader = requestHeaders[HEADER_KEYS.FORWARD_HEADERS];
  if (
    forwardHeadersHeader
      ?.split(',')
      .some((h: string) => h.trim().toLowerCase() === HEADER_KEYS.FORWARD_HEADERS)
  ) {
    return invalidRequest(
      `forward_headers must not contain the '${HEADER_KEYS.FORWARD_HEADERS}' header`,
    );
  }

  warnIgnored(IGNORED_HEADERS.filter((header) => requestHeaders[header] !== undefined));

  // Read as JSON further on, outside any catch, so one that is not JSON became a
  // 500 and a page — for a header naming something the gateway does not act on
  // at all. Answered here as the caller's mistake, the way a malformed config is.
  for (const header of IGNORED_JSON_HEADERS) {
    const value = requestHeaders[header];

    if (value === undefined) continue;

    try {
      parseJson(value);
    } catch {
      return invalidRequest(`Invalid ${header} passed. You need to pass a valid json`);
    }
  }

  if (requestHeaders[`x-${POWERED_BY}-config`]) {
    try {
      const parsedConfig = parseJson<Record<string, any>>(requestHeaders[`x-${POWERED_BY}-config`]);

      // Ahead of the schema, so the answer is the true one. Validated first, a
      // targets config fails on whatever the nested shape got wrong — a reason
      // that reads as though fixing it would help, when nothing here resolves a
      // target at all.
      const unroutable = UNROUTABLE_CONFIG.filter((key) => parsedConfig[key] !== undefined);

      if (unroutable.length > 0) {
        return invalidRequest(
          `Unsupported config: ${unroutable.join(', ')}. ` +
            'This gateway routes each request to a single provider; ' +
            'failover and load balancing are not implemented. ' +
            'Remove these keys and handle them in the caller.',
        );
      }

      warnIgnored(IGNORED_CONFIG.filter((key) => parsedConfig[key] !== undefined));

      // `targets` is refused above, so a config that reaches here and names no
      // provider has none to be found anywhere.
      if (!requestHeaders[`x-${POWERED_BY}-provider`] && !parsedConfig.provider) {
        return invalidRequest(
          `Either x-${POWERED_BY}-provider needs to be passed. Or the x-${POWERED_BY}-config header should have a valid config with provider details in it.`,
        );
      }

      const validatedConfig = configSchema.safeParse(parsedConfig);

      if (!validatedConfig.success && validatedConfig.error?.issues?.length) {
        // Folded into the message rather than carried alongside it: the envelope
        // has one place for what went wrong, and a client that reads the
        // standard shape would never look anywhere else for it.
        //
        // Bounded, because the message is the one field every client logs and
        // the issues come from the caller. Nested `targets` recurse and a failed
        // provider name is reported with the whole list of valid ones, so a
        // config that still fits in a header can produce thousands of issues and
        // close to a megabyte of them — a size the caller would be choosing for
        // somebody else's log.
        const { issues } = validatedConfig.error;
        const reported = issues
          .slice(0, MAX_REPORTED_CONFIG_ISSUES)
          .map((e: any) => `path: ${e.path}, message: ${e.message}`)
          .join('; ');
        const remaining = issues.length - MAX_REPORTED_CONFIG_ISSUES;

        return invalidRequest(
          truncate(
            `Invalid config passed. ${reported}${remaining > 0 ? ` (and ${remaining} more)` : ''}`,
          ),
        );
      }

      if (parsedConfig.options) {
        return invalidRequest(
          'This version of config is not supported in this route. Please migrate to the latest version',
        );
      }
    } catch (error) {
      captureException({ error, message: 'failed to validate request' });

      return invalidRequest('Invalid config passed. You need to pass a valid json');
    }
  }
  return null;
};
