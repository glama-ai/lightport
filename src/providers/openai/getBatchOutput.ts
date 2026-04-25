import { OPEN_AI } from '../../globals';
import type { GatewayContext } from '../../types/GatewayContext';
import { Options } from '../../types/requestBody';
import { externalServiceFetch } from '../../utils/fetch';
import { RetrieveBatchResponse } from '../types';
import OpenAIAPIConfig from './api';

// Return a ReadableStream containing batches output data
export const OpenAIGetBatchOutputRequestHandler = async ({
  c,
  providerOptions,
  requestURL,
}: {
  c: GatewayContext;
  providerOptions: Options;
  requestURL: string;
}) => {
  // get batch details which has output file id
  // get file content as ReadableStream
  // return file content
  const baseUrl = OpenAIAPIConfig.getBaseURL({
    providerOptions,
    fn: 'retrieveBatch',
    c,
    gatewayRequestURL: requestURL,
  });
  const batchId = requestURL.split('/v1/batches/')[1].replace('/output', '');
  const retrieveBatchURL = `${baseUrl}/batches/${batchId}`;
  const retrieveBatchesHeaders = await OpenAIAPIConfig.headers({
    c,
    providerOptions,
    fn: 'retrieveBatch',
    transformedRequestBody: {},
    transformedRequestUrl: retrieveBatchURL,
    gatewayRequestBody: {},
  });
  const retrieveBatchesResponse = await externalServiceFetch(retrieveBatchURL, {
    method: 'GET',
    headers: retrieveBatchesHeaders,
  });

  const batchDetails: RetrieveBatchResponse = await retrieveBatchesResponse.json();
  const outputFileId = batchDetails.output_file_id || batchDetails.error_file_id;
  if (!outputFileId) {
    const errors = batchDetails.errors;
    if (errors) {
      return new Response(JSON.stringify(errors), {
        status: 200,
      });
    }
    return new Response(
      JSON.stringify({
        error: 'invalid response output format',
        provider_response: batchDetails,
        provider: OPEN_AI,
      }),
      {
        status: 400,
      },
    );
  }
  const retrieveFileContentURL = `${baseUrl}/files/${outputFileId}/content`;
  const retrieveFileContentHeaders = await OpenAIAPIConfig.headers({
    c,
    providerOptions,
    fn: 'retrieveFileContent',
    transformedRequestBody: {},
    transformedRequestUrl: retrieveFileContentURL,
    gatewayRequestBody: {},
  });
  const response = await externalServiceFetch(retrieveFileContentURL, {
    method: 'GET',
    headers: retrieveFileContentHeaders,
  });
  return new Response(response.body, {
    headers: { 'Content-Type': 'application/octet-stream' },
  });
};
