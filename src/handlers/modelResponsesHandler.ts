import { gatewayErrorResponse } from '../errors/gatewayErrorResponse';
import { logger } from '../logger';
import { endpointStrings } from '../providers/types';
import { captureException } from '../sentry/captureException';
import type { GatewayContext } from '../types/GatewayContext';
import { constructConfigFromRequestHeaders } from '../utils/request';
import { tryPost } from './handlerUtils';

function modelResponsesHandler(endpoint: endpointStrings, method: 'POST' | 'GET' | 'DELETE') {
  async function handler(c: GatewayContext): Promise<Response> {
    try {
      const request = c.get('requestBodyData');
      const requestHeaders = c.get('mappedHeaders');
      const providerOptions = constructConfigFromRequestHeaders(requestHeaders);

      return await tryPost(
        c,
        providerOptions,
        method === 'POST' ? request.bodyJSON : {},
        requestHeaders,
        endpoint,
        method,
      );
    } catch (err: any) {
      logger.error({ err }, `${endpoint} handler error`);

      captureException({
        error: err,
        extra: { endpoint, method },
        message: `${endpoint} handler error`,
      });

      return gatewayErrorResponse(err);
    }
  }
  return handler;
}

export default modelResponsesHandler;
