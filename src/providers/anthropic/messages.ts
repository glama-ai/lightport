import { ANTHROPIC } from '../../globals';
import { MessagesResponse } from '../../types/messagesResponse';
import { getMessagesConfig } from '../anthropic-base/messages';
import { ErrorResponse } from '../types';
import { generateInvalidProviderResponseError } from '../utils';
import { AnthropicErrorResponse } from './types';
import { AnthropicErrorResponseTransform } from './utils';

export const AnthropicMessagesConfig = getMessagesConfig({});

export const AnthropicMessagesResponseTransform = (
  response: MessagesResponse | AnthropicErrorResponse,
  responseStatus: number,
): MessagesResponse | ErrorResponse => {
  if (responseStatus !== 200 && 'error' in response) {
    return AnthropicErrorResponseTransform(response, ANTHROPIC);
  }

  if ('model' in response) return response;

  return generateInvalidProviderResponseError(response, ANTHROPIC);
};
