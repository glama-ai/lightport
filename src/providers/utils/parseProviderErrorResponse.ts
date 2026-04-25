import { captureException } from '../../sentry/captureException';
import { parseJson } from '../../utils/parseJson';

/**
 * Normalises a raw provider error into a standard JSON Response.
 *
 * Some providers encode error details as a JSON string inside error.message.
 * This helper attempts to parse that JSON and attach the provider name, falling
 * back to a generic error shape if the message is not valid JSON.
 */
export const parseProviderErrorResponse = ({
  captureMessage,
  error,
  provider,
}: {
  captureMessage: string;
  error: { message: string };
  provider: string;
}): Response => {
  let errorResponse: Record<string, any>;
  try {
    errorResponse = parseJson<Record<string, any>>(error.message);
    errorResponse.provider = provider;
  } catch (parseError) {
    captureException({ error: parseError, message: captureMessage });
    errorResponse = {
      error: {
        message: (parseError as Error).message,
        type: null,
        param: null,
        code: 500,
      },
      provider,
    };
  }
  return new Response(JSON.stringify(errorResponse), {
    status: 500,
    headers: { 'Content-Type': 'application/json' },
  });
};
