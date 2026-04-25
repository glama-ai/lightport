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
      } catch {
        bodyJSON = {};
      }
    }
  } else if (contentType === CONTENT_TYPES.MULTIPART_FORM_DATA) {
    // Re-parse from the raw request since Fastify gives us a buffer
    const webRequest = new Request(c.req.url, {
      method: request.method,
      headers: headersObj,
      body: rawBody ? new Uint8Array(rawBody) : undefined,
    });
    bodyFormData = await webRequest.formData();
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
