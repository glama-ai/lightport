import { LEMONFOX_AI } from '../../globals';
import { ErrorResponse, ProviderConfig } from '../types';
import { generateInvalidProviderResponseError } from '../utils';

export const LemonfoxAIcreateTranscriptionConfig: ProviderConfig = {
  file: {
    param: 'file',
    required: true,
  },
  response_format: {
    param: 'response_format',
  },
  prompt: {
    param: 'prompt',
  },
  language: {
    param: 'language',
  },
  translate: {
    param: 'translate',
  },
};

export const LemonfoxAICreateTranscriptionResponseTransform: (
  response: Response | ErrorResponse,
  responseStatus: number,
) => Response | ErrorResponse = (response, responseStatus) => {
  if (responseStatus !== 200 && 'error' in response) {
    return generateInvalidProviderResponseError(response, LEMONFOX_AI);
  }
  return response;
};
