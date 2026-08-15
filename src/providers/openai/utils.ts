import { parseJson } from '../../utils/parseJson';
import { ErrorResponse, ImageGenerateResponse } from '../types';
import { generateErrorResponse } from '../utils';

export const OpenAIErrorResponseTransform: (
  response: ErrorResponse,
  provider: string,
) => ErrorResponse = (response, provider) => {
  return generateErrorResponse(
    {
      ...response.error,
    },
    provider,
  );
};

/**
 * What a body arrives as when the provider mislabelled its content type.
 *
 * OpenAI answers an image request carrying a bad key with `content-type:
 * text/plain` over a body that is JSON. That sends the response down the text
 * path, which hands the transform the whole payload as one string under this
 * key rather than the object every transform here expects.
 */
interface TextWrappedResponse {
  'html-message'?: string;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * An OpenAI-shaped image generation response, normalised.
 *
 * Shared by the providers that serve OpenAI's own image API — OpenAI, Azure
 * OpenAI and OpenRouter — which answer in the same shape and had the same
 * three gaps. Each returned the body verbatim whenever it was not an object
 * carrying `error`, so a payload that arrived as text was handed to the caller
 * still wrapped in `html-message`: an error no OpenAI client can read, for the
 * most ordinary failure there is.
 */
export const OpenAIImageResponseTransform: (
  response: ImageGenerateResponse | ErrorResponse | TextWrappedResponse,
  responseStatus: number,
  provider: string,
) => ImageGenerateResponse | ErrorResponse = (response, responseStatus, provider) => {
  // Read before the status is considered: a mislabelled body arrives this way
  // whatever the provider made of the request, and a 200 wrapped in
  // `html-message` is an image the caller cannot find either.
  if ('html-message' in response) {
    const text = response['html-message'] ?? '';
    let parsed: unknown;

    try {
      parsed = parseJson(text);
    } catch {
      parsed = null;
    }

    // Not JSON after all — an HTML error page from something sitting in front
    // of the API, most likely. The text is all there is to report.
    if (!isObject(parsed)) {
      return generateErrorResponse(
        { message: text, type: null, param: null, code: null },
        provider,
      );
    }

    if (isObject(parsed.error)) {
      return OpenAIErrorResponseTransform(parsed as unknown as ErrorResponse, provider);
    }

    // `error` present but not an object — a provider reporting a failure as a
    // bare string. Spreading that yields a message of `undefined`, so the whole
    // body is reported instead of a word that says nothing.
    if ('error' in parsed) {
      return generateErrorResponse(
        { message: text, type: null, param: null, code: null },
        provider,
      );
    }

    return parsed as unknown as ImageGenerateResponse;
  }

  if (responseStatus !== 200 && 'error' in response) {
    return OpenAIErrorResponseTransform(response as ErrorResponse, provider);
  }

  return response as ImageGenerateResponse;
};
