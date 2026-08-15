import { gatewayErrorResponse } from '../errors/gatewayErrorResponse';
import { logger } from '../logger';
import { captureException } from '../sentry/captureException';
import type { GatewayContext } from '../types/GatewayContext';
import { constructConfigFromRequestHeaders } from '../utils/request';
import { tryPost } from './handlerUtils';

/**
 * There is no adapter behind this one. A provider either serves image
 * generation or it does not, and `transformToProviderRequest` answers the ones
 * that do not with `imageGenerate is not supported by <provider>` at 400 —
 * which is the truth, and not something a translation into chat completions
 * could paper over.
 */
export async function imageGenerationsHandler(c: GatewayContext): Promise<Response> {
  try {
    const request = c.get('requestBodyData');
    const requestHeaders = c.get('mappedHeaders');
    const providerOptions = constructConfigFromRequestHeaders(requestHeaders);

    return await tryPost(
      c,
      providerOptions,
      request.bodyJSON,
      requestHeaders,
      'imageGenerate',
      'POST',
    );
  } catch (err: any) {
    logger.error({ err }, 'imageGenerations handler error');

    captureException({
      error: err,
      message: 'imageGenerations handler error',
    });

    return gatewayErrorResponse(err);
  }
}
