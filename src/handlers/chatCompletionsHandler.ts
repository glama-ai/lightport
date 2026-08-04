import { gatewayErrorResponse } from '../errors/gatewayErrorResponse';
import { logger } from '../logger';
import { captureException } from '../sentry/captureException';
import type { GatewayContext } from '../types/GatewayContext';
import { constructConfigFromRequestHeaders } from '../utils/request';
import { tryPost } from './handlerUtils';

export async function chatCompletionsHandler(c: GatewayContext): Promise<Response> {
  try {
    const request = c.get('requestBodyData');
    const requestHeaders = c.get('mappedHeaders');
    const providerOptions = constructConfigFromRequestHeaders(requestHeaders);

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

    return gatewayErrorResponse(err);
  }
}
