import { AI21 } from '../../globals';
import { EmbedParams, EmbedResponse } from '../../types/embedRequestBody';
import { ErrorResponse, ProviderConfig } from '../types';
import { generateInvalidProviderResponseError } from '../utils';
import { AI21ErrorResponseTransform } from './chatComplete';
import { AI21ErrorResponse } from './complete';

export const AI21EmbedConfig: ProviderConfig = {
  input: {
    param: 'texts',
    required: true,
    transform: (params: EmbedParams): string[] => {
      if (Array.isArray(params.input)) {
        return params.input as string[];
      } else {
        return [params.input];
      }
    },
  },
  type: {
    param: 'type',
  },
};

interface AI21EmbedResponse {
  id: string;
  results: {
    embedding: number[];
  }[];
}

export const AI21EmbedResponseTransform: (
  response: AI21EmbedResponse | AI21ErrorResponse,
  responseStatus: number,
) => EmbedResponse | ErrorResponse = (response, responseStatus) => {
  if (responseStatus !== 200) {
    const errorResponse = AI21ErrorResponseTransform(response as AI21ErrorResponse);
    if (errorResponse) return errorResponse;
  }

  if ('results' in response) {
    return {
      object: 'list',
      data: response.results.map((result, index) => ({
        object: 'embedding',
        embedding: result.embedding,
        index: index,
      })),
      model: '',
      provider: AI21,
      usage: {
        prompt_tokens: -1,
        total_tokens: -1,
      },
    };
  }

  return generateInvalidProviderResponseError(response, AI21);
};
