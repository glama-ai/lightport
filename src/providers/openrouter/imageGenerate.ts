import { OPENROUTER } from '../../globals';
import { OpenAIImageResponseTransform } from '../openai/utils';
import { ErrorResponse, ImageGenerateResponse, ProviderConfig } from '../types';

/**
 * OpenRouter serves image generation from its own endpoint rather than through
 * chat completions, and that endpoint is OpenAI-Images-compatible — so most of
 * this is a passthrough. `response_format` is deliberately absent: OpenRouter
 * always answers with base64 and has no URL mode to ask for, so accepting the
 * parameter would let a caller request `url` and receive `b64_json` anyway.
 *
 * `seed`, `aspect_ratio`, `resolution` and `input_references` are OpenRouter's
 * own additions to the OpenAI shape.
 */
export const OpenrouterImageGenerateConfig: ProviderConfig = {
  prompt: {
    param: 'prompt',
    required: true,
  },
  model: {
    param: 'model',
    required: true,
  },
  n: {
    param: 'n',
    min: 1,
    max: 10,
  },
  size: {
    param: 'size',
  },
  quality: {
    param: 'quality',
  },
  output_format: {
    param: 'output_format',
  },
  seed: {
    param: 'seed',
  },
  aspect_ratio: {
    param: 'aspect_ratio',
  },
  resolution: {
    param: 'resolution',
  },
  input_references: {
    param: 'input_references',
  },
  // Mapped so that the gateway and the provider agree on what is being asked
  // for. `stream` is read off the request before this transform runs and
  // decides whether the gateway reads the response as SSE — dropping it here
  // would leave the gateway waiting for events on a single JSON body.
  stream: {
    param: 'stream',
  },
};

interface OpenrouterImageObject {
  /** OpenRouter always returns base64; it has no URL mode. */
  b64_json?: string;
  /** The image MIME type, absent when OpenRouter cannot determine it. */
  media_type?: string;
}

interface OpenrouterImageGenerateResponse extends ImageGenerateResponse {
  data: OpenrouterImageObject[];
}

export const OpenrouterImageGenerateResponseTransform: (
  response: OpenrouterImageGenerateResponse | ErrorResponse,
  responseStatus: number,
) => ImageGenerateResponse | ErrorResponse = (response, responseStatus) =>
  OpenAIImageResponseTransform(response, responseStatus, OPENROUTER);
