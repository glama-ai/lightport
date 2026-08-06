import { getClientAbortSignal } from '../context/clientAbort';
import { GatewayError } from '../errors/GatewayError';
import { openAiErrorResponse } from '../errors/openAiError';
import { HEADER_KEYS, POWERED_BY, RESPONSE_HEADER_KEYS, CONTENT_TYPES } from '../globals';
import { isValidCustomHost } from '../middlewares/requestValidator/schema/config';
import { describeRequest, measureStage, recordStage } from '../observability/requestTiming';
import Providers from '../providers';
import { ProviderAPIConfig, endpointStrings } from '../providers/types';
import { setRequestTags } from '../sentry/setRequestTags';
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
    // Coerced for the same reason the check on the way in coerces: the config's
    // camelCase spelling is not seen by the schema that requires strings here.
    const lowerCaseHeaderKey = String(h).toLowerCase();
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
  try {
    return await postToProvider(c, providerOption, requestBody, requestHeaders, fn, method);
  } catch (err) {
    // Once the caller has hung up the gateway aborts the provider on their
    // behalf, and everything downstream of that — the fetch, the body read
    // inside responseHandler, the transform — fails as a consequence rather
    // than a fault. Nobody is waiting for a response, and reporting it would
    // page someone for a closed tab. 499 is nginx's convention for the caller
    // going away.
    if (getClientAbortSignal()?.aborted) {
      return new Response(null, { status: 499 });
    }

    throw err;
  }
}

async function postToProvider(
  c: GatewayContext,
  providerOption: Options,
  requestBody: Params | FormData | ArrayBuffer | ReadableStream,
  requestHeaders: Record<string, string>,
  fn: endpointStrings,
  method: string,
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

  // Refines the tags `handleRoute` derived from headers. `provider` is the one
  // resolved from the config, which is the accurate value when the header named
  // nothing and the config did. `originalFn` is the endpoint the caller asked
  // for, since `fn` becomes chatComplete once an adapter takes over.
  setRequestTags({
    adapted: adapterCtx.isActive,
    endpoint: adapterCtx.originalFn,
    model: params.model,
    provider,
    stream: isStreamingMode,
  });

  describeRequest({ model: params.model, provider, stream: isStreamingMode });

  // Mapping providers to corresponding URLs
  const providerConfig = Providers[provider];
  if (!providerConfig) {
    throw new GatewayError(`Provider "${provider}" is not supported`, 400);
  }
  const apiConfig: ProviderAPIConfig = providerConfig.api;

  // Checked here rather than only during validation, because this is where every
  // spelling converges. Validation reads the config's snake_case keys, but the
  // config is converted to camelCase before it becomes `providerOption` — so a
  // config naming `forwardHeaders` instead of `forward_headers` was never seen
  // by the check below, and went around it.
  const forwardHeadersGiven =
    requestHeaders[HEADER_KEYS.FORWARD_HEADERS]?.split(',').map((h) => h.trim()) ||
    providerOption.forwardHeaders ||
    [];

  if (!Array.isArray(forwardHeadersGiven)) {
    throw new GatewayError('forward_headers must be an array of header names', 400);
  }

  const forwardHeaders = forwardHeadersGiven;

  if (
    forwardHeaders.some(
      (h: string) => String(h).trim().toLowerCase() === HEADER_KEYS.FORWARD_HEADERS,
    )
  ) {
    throw new GatewayError(
      `forward_headers must not contain the '${HEADER_KEYS.FORWARD_HEADERS}' header`,
      400,
    );
  }

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

  /*
    The address the request is about to be sent to, whatever named it.

    `custom_host` is not the only setting a caller can put a host in: a provider
    builds its own base URL from the options too, and several return one the
    caller supplied outright — `huggingface_base_url` and `azure_foundry_url` are
    both handed back verbatim — while others interpolate an option into a
    hostname. Checking `customHost` alone left every one of those free to name a
    private address, so the check belongs on the resolved URL, after the provider
    has had its say and before anything is sent.

    An empty base URL is left alone. Six providers return one when no custom host
    is given, and refusing it here would answer "invalid custom host" to a request
    whose problem is that it named no host at all.
  */
  if (baseUrl && !isValidCustomHost(baseUrl, c)) {
    throw new GatewayError('Invalid custom host', 400);
  }
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

  let transformStartedAt = performance.now();

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

  recordStage('transform', performance.now() - transformStartedAt);

  // Build headers. Azure Entra, Vertex and AWS all fetch a token here, and that
  // call reports itself through the same channels the provider call does. Timing
  // it as preparation as well would bill one wait to two stages and leave the
  // stages summing past the total they are meant to explain.
  const headers = await apiConfig.headers({
    c,
    providerOptions: providerOption,
    fn,
    transformedRequestBody,
    transformedRequestUrl: url,
    gatewayRequestBody: params,
    headers: requestHeaders,
  });

  transformStartedAt = performance.now();

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

  // Everything from here on is spent waiting rather than preparing, so the
  // preparation is closed off before the request goes out.
  recordStage('transform', performance.now() - transformStartedAt);

  // Make the request
  const requestTimeout =
    Number(requestHeaders[HEADER_KEYS.REQUEST_TIMEOUT]) || providerOption.requestTimeout || null;
  const proxyUrl = requestHeaders[HEADER_KEYS.PROXY_URL] || undefined;

  let response: Response;

  // The caller's own signal reaches the fetch through externalServiceFetch, so
  // only the timeout needs wiring here.
  let timeoutController: AbortController | null = null;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  if (requestTimeout) {
    const controller = new AbortController();
    timeoutController = controller;
    timeoutId = setTimeout(() => controller.abort(), requestTimeout);
  }

  try {
    response = await externalServiceFetch(
      url,
      { ...fetchOptions, ...(timeoutController && { signal: timeoutController.signal }) },
      proxyUrl,
    );
  } catch (err: any) {
    if (err.name !== 'AbortError') {
      throw err;
    }

    // Both the timeout and the caller hanging up surface as an AbortError, so
    // they have to be told apart. A hangup is left to propagate to tryPost's
    // guard rather than being dressed up as a timeout nobody asked about.
    if (getClientAbortSignal()?.aborted) {
      throw err;
    }

    response = openAiErrorResponse({ message: 'Request timed out', type: 'timeout_error' }, 408);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }

  // Transform the response
  const { response: mappedResponse } = await measureStage('read', () =>
    responseHandler(
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
    ),
  );

  // `updateResponseHeaders` builds a new response rather than mutating the one
  // it is given, so the result is the only thing carrying the trace id and the
  // resolved provider. Dropping it left every caller on this path — which is all
  // of them but the custom request handlers — with none of those headers, and no
  // way to tie a gateway response back to the request that produced it.
  const updatedResponse = updateResponseHeaders(
    mappedResponse,
    0,
    params,
    requestHeaders[HEADER_KEYS.TRACE_ID] ?? '',
    provider,
  );

  return adaptResponse(updatedResponse, adapterCtx, c);
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
