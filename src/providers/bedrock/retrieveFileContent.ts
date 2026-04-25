import { BEDROCK } from '../../globals';
import { getOctetStreamToOctetStreamTransformer } from '../../handlers/streamHandlerUtils';
import type { GatewayContext } from '../../types/GatewayContext';
import { Options } from '../../types/requestBody';
import { externalServiceFetch } from '../../utils/fetch';
import { parseProviderErrorResponse } from '../utils/parseProviderErrorResponse';
import { throwIfNotOk } from '../utils/throwIfNotOk';
import BedrockAPIConfig from './api';

const getRowTransform = () => {
  return (row: Record<string, any>) => row;
};

export const BedrockRetrieveFileContentRequestHandler = async ({
  c,
  providerOptions,
  requestURL,
}: {
  c: GatewayContext;
  providerOptions: Options;
  requestURL: string;
}) => {
  try {
    // construct the base url and endpoint
    const baseURL = await BedrockAPIConfig.getBaseURL({
      providerOptions,
      fn: 'retrieveFileContent',
      c,
      gatewayRequestURL: requestURL,
    });
    const endpoint = BedrockAPIConfig.getEndpoint({
      providerOptions,
      fn: 'retrieveFileContent',
      gatewayRequestURL: requestURL,
      c,
      gatewayRequestBodyJSON: {},
    });
    const url = `${baseURL}${endpoint}`;

    // generate the headers
    const headers = await BedrockAPIConfig.headers({
      c,
      providerOptions,
      fn: 'retrieveFileContent',
      transformedRequestBody: {},
      transformedRequestUrl: url,
      gatewayRequestBody: {},
    });

    // make the request
    const response = await externalServiceFetch(url, {
      method: 'GET',
      headers,
    });

    await throwIfNotOk(response, BEDROCK);

    // transform the streaming response to provider format
    let responseStream: ReadableStream;
    if (response?.body) {
      responseStream = response?.body?.pipeThrough(
        getOctetStreamToOctetStreamTransformer(getRowTransform()),
      );
    } else {
      throw new Error(
        'Failed to parse and transform file content, please verify that the file is a valid jsonl file used for batching or fine-tuning',
      );
    }

    // return the response
    return new Response(responseStream, {
      headers: {
        'content-type': 'application/octet-stream',
      },
    });
  } catch (error: any) {
    return parseProviderErrorResponse({
      captureMessage: 'failed to parse Bedrock retrieve file content error response',
      error,
      provider: BEDROCK,
    });
  }
};

export const BedrockRetrieveFileContentResponseTransform = (response: any) => {
  return response;
};
