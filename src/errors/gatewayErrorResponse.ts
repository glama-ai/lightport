import { GatewayError } from './GatewayError';
import { openAiErrorResponse } from './openAiError';

/**
 * A status the gateway is willing to answer with.
 *
 * This runs inside the handlers' last catch, so a throw from here escapes to
 * Fastify's own handler and the caller gets the ad-hoc shape this exists to
 * remove. `GatewayError.status` is an unconstrained number and `new Response`
 * rejects anything outside 200-599, which is a poor way to find that out.
 */
const toStatus = (status: number): number =>
  Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;

/**
 * The response for an error raised inside the gateway.
 *
 * A message is passed on only when the gateway chose it. `GatewayError` is
 * raised deliberately, with text written to be read by whoever sent the
 * request — an unsupported provider, a config that does not parse. Anything
 * else arrived from a library or a runtime and may name a host, a path or a
 * header the caller has no business seeing, so it goes to the log and the
 * caller is told only that the request failed.
 *
 * That split holds only as long as every `GatewayError` is raised with a message
 * written for a stranger. It is a convention, not something the type system can
 * check, and it is worth keeping in mind at each new throw site.
 *
 * `GatewayError` carries the status it was raised with, which used to be
 * discarded: asking a provider for an endpoint it does not implement is the
 * caller's mistake, and every one of them was answered with a 500 and
 * `Something went wrong` — which tells an OpenAI client to retry, three times
 * with backoff, a request that could not succeed on any attempt.
 */
export const gatewayErrorResponse = (err: unknown): Response => {
  if (err instanceof GatewayError) {
    const status = toStatus(err.status);

    return openAiErrorResponse(
      {
        message: err.message,
        type: status >= 500 ? 'server_error' : 'invalid_request_error',
      },
      status,
    );
  }

  return openAiErrorResponse({ message: 'Something went wrong', type: 'server_error' }, 500);
};
