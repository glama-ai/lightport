import { COHERE } from '../../globals';
import type { GatewayContext } from '../../types/GatewayContext';
import { Options } from '../../types/requestBody';
import { externalServiceFetch } from '../../utils/fetch';
import { parseJson } from '../../utils/parseJson';
import { parseProviderErrorResponse } from '../utils/parseProviderErrorResponse';
import { throwIfNotOk } from '../utils/throwIfNotOk';
import CohereAPIConfig from './api';
import { CohereEmbedResponseTransformBatch } from './embed';
import { CohereGetFileResponse, CohereRetrieveBatchResponse } from './types';
import avro from 'avsc';

export const CohereGetBatchOutputHandler = async ({
  c,
  providerOptions,
  requestURL,
}: {
  c: GatewayContext;
  providerOptions: Options;
  requestURL: string;
}) => {
  try {
    // get the base url and endpoint for retrieveBatch
    const baseURL = CohereAPIConfig.getBaseURL({
      providerOptions,
      fn: 'retrieveBatch',
      c,
      gatewayRequestURL: requestURL,
    });
    const endpoint = CohereAPIConfig.getEndpoint({
      providerOptions,
      fn: 'retrieveBatch',
      gatewayRequestURL: requestURL.replace('/output', ''),
      c,
      gatewayRequestBodyJSON: {},
    });
    const headers = await CohereAPIConfig.headers({
      providerOptions,
      fn: 'retrieveBatch',
      c,
      transformedRequestUrl: baseURL + endpoint,
      transformedRequestBody: {},
    });
    // get the batch details
    const retrieveBatchResponse = await externalServiceFetch(baseURL + endpoint, {
      method: 'GET',
      headers,
    });
    await throwIfNotOk(retrieveBatchResponse, COHERE);
    const batchDetails: CohereRetrieveBatchResponse = await retrieveBatchResponse.json();
    const outputFileId = batchDetails.output_dataset_id;

    // get the file details
    const retrieveFileResponse = await externalServiceFetch(
      `https://api.cohere.ai/v1/datasets/${outputFileId}`,
      {
        method: 'GET',
        headers,
      },
    );
    await throwIfNotOk(retrieveFileResponse, COHERE);
    const retrieveFileResponseJson: CohereGetFileResponse = await retrieveFileResponse.json();

    if (!retrieveFileResponseJson.dataset.dataset_parts) {
      throw new Error('file not found');
    }

    const stream = new ReadableStream({
      start: async (controller) => {
        const fileParts = retrieveFileResponseJson.dataset.dataset_parts;
        for (const filePart of fileParts) {
          const filePartResponse = await externalServiceFetch(filePart.url, {
            method: 'GET',
            headers,
          });
          const arrayBuffer = await filePartResponse.arrayBuffer();
          const buf = Buffer.from(arrayBuffer);
          const decoder = new avro.streams.BlockDecoder({
            parseHook: (schema: any) => {
              return avro.Type.forSchema(schema, { wrapUnions: true });
            },
          });
          const encoder = new TextEncoder();
          decoder.on('data', (data: any) => {
            controller.enqueue(
              encoder.encode(JSON.stringify(CohereEmbedResponseTransformBatch(parseJson(data)))),
            );
            controller.enqueue(encoder.encode('\n'));
          });
          decoder.on('end', () => {
            controller.close();
          });
          decoder.end(buf);
        }
      },
    });
    return new Response(stream, {
      headers: { 'Content-Type': 'application/octet-stream' },
    });
  } catch (error: any) {
    return parseProviderErrorResponse({
      captureMessage: 'failed to parse Cohere batch output error response',
      error,
      provider: COHERE,
    });
  }
};
