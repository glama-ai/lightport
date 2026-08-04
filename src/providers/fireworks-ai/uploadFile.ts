import { GatewayError } from '../../errors/GatewayError';
import { FIREWORKS_AI } from '../../globals';
import { createLineSplitter } from '../../handlers/streamHandlerUtils';
import { logger } from '../../logger';
import { externalServiceFetch } from '../../utils/fetch';
import { parseJson } from '../../utils/parseJson';
import { RequestHandler } from '../types';
import FireworksAIAPIConfig from './api';
import { createDataset, getUploadEndpoint, validateDataset } from './utils';

/**
 * An upload step that failed, told to the caller without the detail of why.
 *
 * `reason` carried whatever the step had to hand — an upstream body, or a
 * runtime message naming the host it could not reach — straight onto the wire.
 * The message here is the gateway's own; the reason goes to the log, which is
 * the same split every other error in the gateway is answered under.
 */
const uploadFailed = (message: string, reason: unknown, context: Record<string, unknown> = {}) => {
  logger.error({ ...context, reason }, message);

  return new Response(
    JSON.stringify({
      error: {
        code: 400,
        message,
        provider: FIREWORKS_AI,
      },
    }),
    {
      status: 400,
      headers: {
        'Content-Type': 'application/json',
      },
    },
  );
};

export const FireworkFileUploadRequestHandler: RequestHandler<ReadableStream> = async ({
  requestURL,
  requestBody,
  providerOptions,
  c,
  requestHeaders,
}) => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const headers = await FireworksAIAPIConfig.headers({
    c,
    providerOptions,
    fn: 'uploadFile',
    transformedRequestBody: requestBody,
    transformedRequestUrl: requestURL,
  });

  const { fireworksFileLength } = providerOptions;

  const contentLength = Number.parseInt(fireworksFileLength || requestHeaders['content-length']);

  const baseURL = await FireworksAIAPIConfig.getBaseURL({
    c,
    providerOptions,
    gatewayRequestURL: requestURL,
  });

  const datasetId = `ft-${crypto.randomUUID()}`;

  const { created, error: createError } = await createDataset({
    datasetId,
    baseURL,
    headers,
  });

  if (!created || createError) {
    return uploadFailed('Failed to create dataset', createError, { datasetId });
  }

  const { endpoint: preSignedUrl, error } = await getUploadEndpoint({
    baseURL,
    contentLength,
    datasetId,
    headers,
  });

  if (error || !preSignedUrl) {
    return uploadFailed('Failed to get upload endpoint', error, { datasetId });
  }

  let length = 0;

  // body might contain headers of form-data, cleaning it to match the content-length for gcs URL.
  const streamBody = new TransformStream({
    transform(chunk, controller) {
      try {
        const decodedChunk = decoder.decode(chunk);
        parseJson(decodedChunk);
        length += chunk.length + 1;
        controller.enqueue(chunk);
        controller.enqueue(encoder.encode('\n'));
      } catch {
        return;
      }
    },
    flush(controller) {
      controller.terminate();
    },
  });

  const lineSplitter = createLineSplitter();

  requestBody.pipeThrough(lineSplitter).pipeTo(streamBody.writable);

  try {
    const options = {
      method: 'PUT',
      body: streamBody.readable,
      duplex: 'half',
      headers: {
        'Content-Type': 'application/octet-stream',
        'x-goog-content-length-range': `${contentLength},${contentLength}`,
      },
    };

    const uploadResponse = await externalServiceFetch(preSignedUrl, options);

    // TODO: Remove this after testing.
    logger.info({ contentLength, length }, 'file length from request - actual file length');

    if (!uploadResponse.ok) {
      return uploadFailed('Unable to upload file', await uploadResponse.text(), {
        contentLength,
        datasetId,
      });
    }

    const { valid, error } = await validateDataset({
      datasetId,
      baseURL,
      headers,
    });

    if (!valid || error) {
      return uploadFailed('Failed to validate dataset', error, { datasetId });
    }

    const fileResponse = {
      id: datasetId,
      bytes: contentLength,
      create_at: Date.now(),
      filename: `${datasetId}.jsonl`,
      status: 'processed',
      purpose: 'fine-tune',
    };

    return new Response(JSON.stringify(fileResponse), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  } catch (error) {
    // The caught error is whatever fetch or the runtime raised, and it may name
    // an upstream host or a path. A GatewayError message is answered to the
    // caller verbatim, so the cause is carried for the log instead of the wire.
    throw new GatewayError('Failed to upload file to fireworks-ai', 500, error as Error);
  }
};
