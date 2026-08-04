import { GatewayError } from '../../errors/GatewayError';
import type { GatewayContext } from '../../types/GatewayContext';
import { parseJson } from '../../utils/parseJson';
import { CONTENT_TYPES } from '../../globals';
import type { FastifyRequest } from 'fastify';

function getContentType(headersObj: Record<string, string>) {
  if ('content-type' in headersObj) {
    return headersObj['content-type'].split(';')[0];
  }
  return null;
}

export const parseBody = async (request: FastifyRequest, c: GatewayContext) => {
  const headersObj = request.headers as Record<string, string>;
  const contentType = getContentType(headersObj);
  const rawBody = request.body as Buffer | undefined;

  let bodyJSON: any = {};
  let bodyFormData = null;
  let requestBinary = null;

  if (contentType === CONTENT_TYPES.APPLICATION_JSON) {
    if (request.method !== 'GET' && request.method !== 'DELETE' && rawBody?.length) {
      try {
        bodyJSON = parseJson(rawBody.toString());
      } catch (cause) {
        // Substituting `{}` sent the request upstream with an empty body and
        // returned whatever the provider made of that — so a body the caller
        // mistyped came back as an authentication failure, or as a completion
        // of nothing. A request that cannot be read is the caller's to fix and
        // is answered as such.
        throw new GatewayError('Request body is not valid JSON', 400, cause as Error);
      }
    }
  } else if (contentType === CONTENT_TYPES.MULTIPART_FORM_DATA) {
    // Re-parse from the raw request since Fastify gives us a buffer
    const webRequest = new Request(c.req.url, {
      method: request.method,
      headers: headersObj,
      body: rawBody ? new Uint8Array(rawBody) : undefined,
    });

    try {
      bodyFormData = await webRequest.formData();
    } catch (cause) {
      // Thrown as a bare TypeError, which carries no status: it escaped every
      // handler's catch to Fastify's own, where it became a 500 that told an
      // OpenAI client to retry a body no attempt could parse — and paged
      // someone once per attempt.
      throw new GatewayError('Request body is not valid multipart form data', 400, cause as Error);
    }

    bodyFormData.forEach((value, key) => {
      bodyJSON[key] = value;
    });
  }

  if (
    contentType?.startsWith(CONTENT_TYPES.GENERIC_AUDIO_PATTERN) ||
    contentType?.startsWith(CONTENT_TYPES.APPLICATION_OCTET_STREAM) ||
    contentType === CONTENT_TYPES.PROTOBUF
  ) {
    if (rawBody) {
      requestBinary = rawBody.buffer.slice(
        rawBody.byteOffset,
        rawBody.byteOffset + rawBody.byteLength,
      );
    }
  }

  c.set('mappedHeaders', headersObj);
  c.set('requestBodyData', { bodyJSON, bodyFormData, requestBinary });
};
