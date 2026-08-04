import { openAiErrorResponse } from '../../errors/openAiError';
import { CONTENT_TYPES, HEADER_KEYS, POWERED_BY, VALID_PROVIDERS } from '../../globals';
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

  if (requestHeaders[`x-${POWERED_BY}-config`]) {
    try {
      const parsedConfig = parseJson<Record<string, any>>(requestHeaders[`x-${POWERED_BY}-config`]);
      if (
        !requestHeaders[`x-${POWERED_BY}-provider`] &&
        !(parsedConfig.provider || parsedConfig.targets)
      ) {
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
