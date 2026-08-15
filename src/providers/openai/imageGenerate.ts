import { OPEN_AI } from '../../globals';
import { ErrorResponse, ImageGenerateResponse, ProviderConfig } from '../types';
import { OpenAIImageResponseTransform } from './utils';

export const OpenAIImageGenerateConfig: ProviderConfig = {
  prompt: {
    param: 'prompt',
    required: true,
  },
  model: {
    param: 'model',
    required: true,
    default: 'dall-e-2',
  },
  n: {
    param: 'n',
    min: 1,
    max: 10,
  },
  quality: {
    param: 'quality',
  },
  response_format: {
    param: 'response_format',
  },
  size: {
    param: 'size',
  },
  style: {
    param: 'style',
  },
  user: {
    param: 'user',
  },
  moderation: {
    param: 'moderation',
  },
  output_format: {
    param: 'output_format',
  },
  output_compression: {
    param: 'output_compression',
    min: 0,
    max: 100,
  },
  background: {
    param: 'background',
  },
  partial_images: {
    param: 'partial_images',
    min: 0,
    max: 3,
  },
  stream: {
    param: 'stream',
  },
};

interface OpenAIImageObject {
  b64_json?: string; // The base64-encoded JSON of the generated image, if response_format is b64_json.
  url?: string; // The URL of the generated image, if response_format is url (default).
  revised_prompt?: string; // The prompt that was used to generate the image, if there was any revision to the prompt.
}

interface OpenAIImageGenerateResponse extends ImageGenerateResponse {
  data: OpenAIImageObject[];
}

export const OpenAIImageGenerateResponseTransform: (
  response: OpenAIImageGenerateResponse | ErrorResponse,
  responseStatus: number,
) => ImageGenerateResponse | ErrorResponse = (response, responseStatus) =>
  OpenAIImageResponseTransform(response, responseStatus, OPEN_AI);
