import { RouterError } from '../errors/RouterError';
import { logger } from '../logger';
import { captureException } from '../sentry/captureException';
import type { GatewayContext } from '../types/GatewayContext';
import { Options } from '../types/requestBody';
import { constructConfigFromRequestHeaders } from '../utils/request';
import { tryPost } from './handlerUtils';

export async function chatCompletionsHandler(c: GatewayContext): Promise<Response> {
  try {
    const request = c.get('requestBodyData');
    const requestHeaders = c.get('mappedHeaders');
    const providerOptions = constructConfigFromRequestHeaders(requestHeaders) as Options;

    return await tryPost(
      c,
      providerOptions,
      request.bodyJSON,
      requestHeaders,
      'chatComplete',
      'POST',
    );
  } catch (err: any) {
    logger.error({ err }, 'chatCompletions handler error');

    captureException({
      error: err,
      message: 'chatCompletions handler error',
    });

    let statusCode = 500;
    let errorMessage = 'Something went wrong';

    if (err instanceof RouterError) {
      statusCode = 400;
      errorMessage = err.message;
    }

    return new Response(
      JSON.stringify({
        status: 'failure',
        message: errorMessage,
      }),
      {
        status: statusCode,
        headers: {
          'content-type': 'application/json',
        },
      },
    );
  }
}
