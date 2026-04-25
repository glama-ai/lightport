import { FIREWORKS_AI } from '../../globals';
import { Message, Params } from '../../types/requestBody';
import { ErrorResponse, ProviderConfig } from '../types';
import { generateErrorResponse } from '../utils';

export const FireworksAIChatCompleteConfig: ProviderConfig = {
  model: {
    param: 'model',
    required: true,
  },
  messages: {
    param: 'messages',
    required: true,
    default: [],
    transform: (params: Params) => {
      return params.messages?.map((message: Message) => {
        if (message.role === 'developer') return { ...message, role: 'system' };
        return message;
      });
    },
  },
  tools: {
    param: 'tools',
  },
  max_tokens: {
    param: 'max_tokens',
    default: 200,
    min: 1,
  },
  max_completion_tokens: {
    param: 'max_tokens',
    default: 200,
    min: 1,
  },
  prompt_truncate_len: {
    param: 'prompt_truncate_len',
    default: 1500,
  },
  temperature: {
    param: 'temperature',
    default: 1,
    min: 0,
    max: 2,
  },
  top_p: {
    param: 'top_p',
    default: 1,
    min: 0,
    max: 1,
  },
  top_k: {
    param: 'top_k',
    min: 1,
    max: 128,
  },
  frequency_penalty: {
    param: 'frequency_penalty',
    min: -2,
    max: 2,
  },
  presence_penalty: {
    param: 'presence_penalty',
    min: -2,
    max: 2,
  },
  n: {
    param: 'n',
    default: 1,
    min: 1,
    max: 128,
  },
  stop: {
    param: 'stop',
  },
  response_format: {
    param: 'response_format',
  },
  stream: {
    param: 'stream',
    default: false,
  },
  context_length_exceeded_behavior: {
    param: 'context_length_exceeded_behavior',
  },
  user: {
    param: 'user',
  },
  logprobs: {
    param: 'logprobs',
  },
  top_logprobs: {
    param: 'top_logprobs',
  },
  prompt_cache_max_len: {
    param: 'prompt_cache_max_len',
  },
};

export interface FireworksAIValidationErrorResponse {
  fault: {
    faultstring: string;
    detail: {
      errorcode: string;
    };
  };
}

export interface FireworksAIErrorResponse extends ErrorResponse {}


export const FireworksAIErrorResponseTransform: (
  response: FireworksAIValidationErrorResponse | FireworksAIErrorResponse,
) => ErrorResponse = (response) => {
  if ('fault' in response) {
    return generateErrorResponse(
      {
        message: response.fault.faultstring,
        type: null,
        param: null,
        code: response.fault.detail.errorcode,
      },
      FIREWORKS_AI,
    );
  } else if ('detail' in response) {
    return generateErrorResponse(
      {
        message: response.detail as string,
        type: null,
        param: null,
        code: null,
      },
      FIREWORKS_AI,
    );
  }
  return generateErrorResponse(response.error, FIREWORKS_AI);
};

