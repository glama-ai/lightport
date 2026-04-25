import { AZURE_OPEN_AI } from '../../globals';
import { logger } from '../../logger';
import { captureException } from '../../sentry/captureException';
import type { GatewayContext } from '../../types/GatewayContext';
import { Options } from '../../types/requestBody';
import { externalServiceFetch } from '../../utils/fetch';
import { parseJson } from '../../utils/parseJson';
import { RequestHandler, RetrieveBatchResponse } from '../types';
import { generateErrorResponse } from '../utils';
import AzureOpenAIAPIConfig from './api';

// Return a ReadableStream containing batches output data
export const AzureOpenAIGetBatchOutputRequestHandler: RequestHandler = async ({
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
  const baseUrl = AzureOpenAIAPIConfig.getBaseURL({
    providerOptions,
    fn: 'retrieveBatch',
    c,
    gatewayRequestURL: requestURL,
  });
  const retrieveBatchRequestURL = requestURL.replace('/output', '');
  const retrieveBatchURL =
    baseUrl +
    AzureOpenAIAPIConfig.getEndpoint({
      providerOptions,
      fn: 'retrieveBatch',
      gatewayRequestURL: retrieveBatchRequestURL,
      c,
      gatewayRequestBodyJSON: {},
      gatewayRequestBody: {},
    });
  const retrieveBatchesHeaders = await AzureOpenAIAPIConfig.headers({
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

  const outputBlob = batchDetails.output_blob || batchDetails.error_blob;
  if (!outputFileId && !outputBlob) {
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
        provider: AZURE_OPEN_AI,
      }),
      {
        status: 400,
      },
    );
  }

  let response: Response | null = null;
  if (outputFileId) {
    const retrieveFileContentRequestURL = `https://api.lightport.ai/v1/files/${outputFileId}/content`; // construct the entire url instead of the path of sanity sake
    const retrieveFileContentURL =
      baseUrl +
      AzureOpenAIAPIConfig.getEndpoint({
        providerOptions,
        fn: 'retrieveFileContent',
        gatewayRequestURL: retrieveFileContentRequestURL,
        c,
        gatewayRequestBodyJSON: {},
        gatewayRequestBody: {},
      });
    const retrieveFileContentHeaders = await AzureOpenAIAPIConfig.headers({
      c,
      providerOptions,
      fn: 'retrieveFileContent',
      transformedRequestBody: {},
      transformedRequestUrl: retrieveFileContentURL,
      gatewayRequestBody: {},
    });

    response = await externalServiceFetch(retrieveFileContentURL, {
      method: 'GET',
      headers: retrieveFileContentHeaders,
    });
  }
  if (outputBlob) {
    const retrieveBlobHeaders = await AzureOpenAIAPIConfig.headers({
      c,
      providerOptions: {
        ...providerOptions,
        azureEntraScope: 'https://storage.azure.com/.default',
      },
      fn: 'retrieveFileContent',
      transformedRequestBody: {},
      transformedRequestUrl: outputBlob,
      gatewayRequestBody: {},
    });
    response = await externalServiceFetch(outputBlob, {
      method: 'GET',
      headers: {
        ...retrieveBlobHeaders,
        'x-ms-date': new Date().toUTCString(),
        'x-ms-version': '2022-11-02',
      },
    });
  }

  try {
    if (!response || !response.ok) {
      const errorResponse = (await response?.text()) || 'Failed to retrieve batch output';
      return new Response(
        JSON.stringify(
          generateErrorResponse(
            {
              message: errorResponse,
              type: null,
              param: null,
              code: null,
            },
            AZURE_OPEN_AI,
          ),
        ),
        {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
          },
        },
      );
    }

    return new Response(response.body, {
      headers: { 'Content-Type': 'application/octet-stream' },
    });
  } catch (error: any) {
    logger.error({ err: error }, 'error in AzureOpenAIGetBatchOutputRequestHandler');
    let errorResponse;
    try {
      errorResponse = parseJson<Record<string, any>>(error.message);
    } catch (error) {
      captureException({ error, message: 'failed to parse Azure OpenAI batch error response' });
      errorResponse = 'Unable to get batch output';
    }
    return new Response(
      JSON.stringify({
        error: {
          message: errorResponse,
          type: null,
          param: null,
          code: null,
        },
        provider: AZURE_OPEN_AI,
      }),
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
        },
      },
    );
  }
};
