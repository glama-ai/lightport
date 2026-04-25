import { OPEN_AI } from '../../globals';
import { ErrorResponse } from '../types';
import { OpenAIErrorResponseTransform } from './utils';
import { Readable } from 'stream';

export const OpenAIFileUploadRequestTransform = (requestBody: ReadableStream) => {
  return Readable.fromWeb(requestBody as any);
};

export const OpenAIUploadFileResponseTransform: (
  response: Response | ErrorResponse,
  responseStatus: number,
) => Response | ErrorResponse = (response, responseStatus) => {
  if (responseStatus !== 200 && 'error' in response) {
    return OpenAIErrorResponseTransform(response, OPEN_AI);
  }

  return response;
};
