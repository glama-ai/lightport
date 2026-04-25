import { GatewayError } from '../errors/GatewayError';
import { HEADER_KEYS, POWERED_BY, RESPONSE_HEADER_KEYS, CONTENT_TYPES } from '../globals';
import Providers from '../providers';
import { ProviderAPIConfig, endpointStrings } from '../providers/types';
import transformToProviderRequest from '../services/transformToProviderRequest';
import type { GatewayContext } from '../types/GatewayContext';
import { Options, Params } from '../types/requestBody';
import { externalServiceFetch } from '../utils/fetch';
import { applyAdapterRequestTransform, adaptResponse, AdapterContext } from './adapterUtils';
import { responseHandler } from './responseHandlers';
import { Readable } from 'stream';

/**
 * Constructs the request options for the API call.
 */
function constructRequest(
  providerConfigMappedHeaders: any,
  provider: string,
  method: string,
  forwardHeaders: string[],
  requestHeaders: Record<string, string>,
  _fn: endpointStrings,
) {
  const baseHeaders: any = {
    'content-type': 'application/json',
  };

  let headers: Record<string, string> = {};

  Object.keys(providerConfigMappedHeaders).forEach((h: string) => {
    headers[h.toLowerCase()] = providerConfigMappedHeaders[h];
  });

  const forwardHeadersMap: Record<string, string> = {};

  forwardHeaders.forEach((h: string) => {
    const lowerCaseHeaderKey = h.toLowerCase();
    if (requestHeaders[lowerCaseHeaderKey])
      forwardHeadersMap[lowerCaseHeaderKey] = requestHeaders[lowerCaseHeaderKey];
  });

  headers = {
    ...baseHeaders,
    ...headers,
    ...forwardHeadersMap,
  };

  const fetchOptions: RequestInit = {
    method,
    headers,
  };

  const contentType = headers['content-type']?.split(';')[0];
  const isGetMethod = method === 'GET';
  const isMultipartFormData = contentType === CONTENT_TYPES.MULTIPART_FORM_DATA;
  const shouldDeleteContentTypeHeader =
    (isGetMethod || isMultipartFormData) && fetchOptions.headers;

  if (shouldDeleteContentTypeHeader) {
    const headers = fetchOptions.headers as Record<string, unknown>;
    delete headers['content-type'];
  }

  return fetchOptions;
}

/**
 * Makes a request to a provider and returns the response.
 */
export async function tryPost(
  c: GatewayContext,
  providerOption: Options,
  requestBody: Params | FormData | ArrayBuffer | ReadableStream,
  requestHeaders: Record<string, string>,
  fn: endpointStrings,
  method: string = 'POST',
): Promise<Response> {
  const overrideParams = providerOption?.overrideParams || {};
  let params: Params =
    requestBody instanceof ReadableStream || requestBody instanceof FormData
      ? {}
      : { ...requestBody, ...overrideParams };
  const isStreamingMode = params.stream ? true : false;
  let strictOpenAiCompliance = true;

  if (requestHeaders[HEADER_KEYS.STRICT_OPEN_AI_COMPLIANCE] === 'false') {
    strictOpenAiCompliance = false;
  } else if (providerOption.strictOpenAiCompliance === false) {
    strictOpenAiCompliance = false;
  }

  const provider: string = providerOption.provider ?? '';

  // --- Messages/Responses API Adapter ---
  const adapterResult = applyAdapterRequestTransform(
    fn,
    provider,
    params,
    requestBody,
    isStreamingMode,
    method,
  );
  if (adapterResult instanceof Response) return adapterResult;

  let adapterCtx: AdapterContext = {
    isActive: false,
    originalFn: fn,
    originalRequest: null,
    provider,
  };
  if (adapterResult) {
    ({ params, requestBody, fn } = adapterResult);
    adapterCtx = adapterResult.adapterCtx;
    strictOpenAiCompliance = false;
  }

  // Mapping providers to corresponding URLs
  const providerConfig = Providers[provider];
  if (!providerConfig) {
    throw new GatewayError(`Provider "${provider}" is not supported`, 400);
  }
  const apiConfig: ProviderAPIConfig = providerConfig.api;

  const forwardHeaders =
    requestHeaders[HEADER_KEYS.FORWARD_HEADERS]?.split(',').map((h) => h.trim()) ||
    providerOption.forwardHeaders ||
    [];

  const customHost = requestHeaders[HEADER_KEYS.CUSTOM_HOST] || providerOption.customHost || '';
  const baseUrl =
    customHost ||
    (await apiConfig.getBaseURL({
      providerOptions: providerOption,
      fn,
      c,
      gatewayRequestURL: c.req.url,
      params: params,
    }));
  const endpoint = apiConfig.getEndpoint({
    c,
    providerOptions: providerOption,
    fn,
    gatewayRequestBodyJSON: params,
    gatewayRequestBody: {},
    gatewayRequestURL: c.req.url,
  });

  const url = `${baseUrl}${endpoint}`;

  // Check for custom request handler (e.g., bedrock AWS signing)
  const requestHandlers = providerConfig.requestHandlers;
  if (requestHandlers && requestHandlers[fn]) {
    const customResponse = await requestHandlers[fn]!({
      c,
      providerOptions: providerOption,
      requestURL: c.req.url,
      requestHeaders,
      requestBody,
    });

    const { response: mappedResponse } = await responseHandler(
      c,
      customResponse,
      isStreamingMode,
      provider,
      fn,
      url,
      false,
      params,
      strictOpenAiCompliance,
      c.req.url,
    );

    const updatedResponse = updateResponseHeaders(
      mappedResponse,
      0,
      params,
      requestHeaders[HEADER_KEYS.TRACE_ID] ?? '',
      provider,
    );

    return adaptResponse(updatedResponse, adapterCtx, c);
  }

  // Transform request body for the provider
  let transformedRequestBody: ReadableStream | FormData | Params =
    method === 'POST'
      ? transformToProviderRequest(
          provider,
          params,
          requestBody,
          fn,
          requestHeaders,
          providerOption,
        )
      : requestBody;

  // Build headers
  const headers = await apiConfig.headers({
    c,
    providerOptions: providerOption,
    fn,
    transformedRequestBody,
    transformedRequestUrl: url,
    gatewayRequestBody: params,
    headers: requestHeaders,
  });

  // Construct fetch options
  const fetchOptions = constructRequest(
    headers,
    provider,
    method,
    forwardHeaders,
    requestHeaders,
    fn,
  );

  // Set body based on content type
  const headerContentType = headers[HEADER_KEYS.CONTENT_TYPE];
  const requestContentType = requestHeaders[HEADER_KEYS.CONTENT_TYPE?.toLowerCase()]?.split(';')[0];

  if (headerContentType === CONTENT_TYPES.MULTIPART_FORM_DATA) {
    fetchOptions.body = transformedRequestBody as FormData;
  } else if (
    transformedRequestBody instanceof ReadableStream ||
    transformedRequestBody instanceof Readable
  ) {
    fetchOptions.body = transformedRequestBody as any;
  } else if (requestContentType) {
    fetchOptions.body = JSON.stringify(transformedRequestBody);
  }

  if (['GET', 'DELETE'].includes(method)) {
    delete fetchOptions.body;
  }

  const customOptions = apiConfig?.getOptions?.();
  if (customOptions) {
    Object.assign(fetchOptions, customOptions);
  }

  // Make the request
  const requestTimeout =
    Number(requestHeaders[HEADER_KEYS.REQUEST_TIMEOUT]) || providerOption.requestTimeout || null;
  const proxyUrl = requestHeaders[HEADER_KEYS.PROXY_URL] || undefined;

  let response: Response;

  if (requestTimeout) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), requestTimeout);
    try {
      response = await externalServiceFetch(
        url,
        { ...fetchOptions, signal: controller.signal },
        proxyUrl,
      );
    } catch (err: any) {
      if (err.name === 'AbortError') {
        response = new Response(
          JSON.stringify({
            error: { message: 'Request timed out', type: 'timeout_error' },
          }),
          { status: 408, headers: { 'content-type': 'application/json' } },
        );
      } else {
        throw err;
      }
    } finally {
      clearTimeout(timeoutId);
    }
  } else {
    response = await externalServiceFetch(url, fetchOptions, proxyUrl);
  }

  // Transform the response
  const { response: mappedResponse } = await responseHandler(
    c,
    response,
    isStreamingMode,
    provider,
    fn,
    url,
    false,
    params,
    strictOpenAiCompliance,
    c.req.url,
  );

  updateResponseHeaders(
    mappedResponse,
    0,
    params,
    requestHeaders[HEADER_KEYS.TRACE_ID] ?? '',
    provider,
  );

  return adaptResponse(mappedResponse, adapterCtx, c);
}

/**
 * Updates the response headers with the provided values.
 */
function updateResponseHeaders(
  response: Response,
  currentIndex: string | number,
  params: Record<string, any>,
  traceId: string,
  provider: string,
): Response {
  const headers = new Headers(response.headers);

  headers.set(RESPONSE_HEADER_KEYS.LAST_USED_OPTION_INDEX, currentIndex.toString());

  if (traceId) {
    headers.set(RESPONSE_HEADER_KEYS.TRACE_ID, traceId);
  }

  headers.delete('transfer-encoding');
  if (provider && provider !== POWERED_BY) {
    headers.set(HEADER_KEYS.PROVIDER, provider);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
