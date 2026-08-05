import { NCOMPASS } from '../../globals';
import { Params } from '../../types/requestBody';
import { parseJson } from '../../utils/parseJson';
import { ChatCompletionResponse, ErrorResponse, ProviderConfig } from '../types';
import {
  generateErrorResponse,
  generateInvalidProviderResponseError,
  transformReasoning,
  transformUsageDetails,
} from '../utils';

// TODOS: this configuration might have to check on the max value of n

export const NCompassChatCompleteConfig: ProviderConfig = {
  model: {
    param: 'model',
    required: true,
    default: 'meta-llama/Llama-3.3-70B-Instruct',
  },
  messages: {
    param: 'messages',
    required: true,
    default: [],
    transform: (params: Params) => {
      return params.messages?.map((message) => {
        if (message.role === 'developer') return { ...message, role: 'system' };
        return message;
      });
    },
  },
  frequency_penalty: {
    param: 'frequency_penalty',
    default: 0,
    min: -2,
    max: 2,
  },
  max_tokens: {
    param: 'max_tokens',
    default: 100,
    min: 1,
  },
  max_completion_tokens: {
    param: 'max_tokens',
    default: 100,
    min: 1,
  },
  n: {
    param: 'n',
    default: 1,
    min: 1,
    max: 1,
  },
  presence_penalty: {
    param: 'presence_penalty',
    min: -2,
    max: 2,
    default: 0,
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
  stop: {
    param: 'stop',
    default: null,
  },
  stream: {
    param: 'stream',
    default: false,
  },
  tools: {
    param: 'tools',
  },
  tool_choice: {
    param: 'tool_choice',
  },
  parallel_tool_calls: {
    param: 'parallel_tool_calls',
  },
};

export interface NCompassErrorResponse {
  detail: {
    loc: string[];
    msg: string;
    type: string;
  }[];
}

interface NCompassStreamChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: {
    delta: {
      role?: string | null;
      content?: string;
      // Forwarded whole below, so these reach the caller already. They are
      // spelled out because the non-streaming transform rebuilds the message
      // instead, and left them out for as long as nothing said they were here.
      reasoning_content?: string;
      tool_calls?: any[];
    };
    index: number;
    finish_reason: string | null;
  }[];
}

export const NCompassChatCompleteResponseTransform: (
  response: ChatCompletionResponse | NCompassErrorResponse,
  responseStatus: number,
  responseHeaders: Headers,
  strictOpenAiCompliance: boolean,
) => ChatCompletionResponse | ErrorResponse = (
  response,
  responseStatus,
  _responseHeaders,
  strictOpenAiCompliance,
) => {
  if ('detail' in response && responseStatus !== 200 && response.detail.length) {
    let firstError: Record<string, any> | undefined;
    let errorField: string | null = null;
    let errorMessage: string | undefined;
    let errorType: string | null = null;

    if (Array.isArray(response.detail)) {
      [firstError] = response.detail;
      errorField = firstError?.loc?.join('.') ?? '';
      errorMessage = firstError.msg;
      errorType = firstError.type;
    } else {
      errorMessage = response.detail;
    }

    return generateErrorResponse(
      {
        message: `${errorField ? `${errorField}: ` : ''}${errorMessage}`,
        type: errorType,
        param: null,
        code: null,
      },
      NCOMPASS,
    );
  }

  if ('choices' in response) {
    return {
      id: response.id,
      object: response.object,
      created: response.created,
      model: response.model,
      provider: NCOMPASS,
      choices: response.choices.map((c) => ({
        index: c.index,
        message: {
          role: c.message.role,
          content: c.message.content,
          ...(c.message.tool_calls?.length && { tool_calls: c.message.tool_calls }),
          ...transformReasoning(c.message, strictOpenAiCompliance),
        },
        finish_reason: c.finish_reason,
      })),
      usage: {
        prompt_tokens: response.usage?.prompt_tokens ?? 0,
        completion_tokens: response.usage?.completion_tokens ?? 0,
        total_tokens: response.usage?.total_tokens ?? 0,
        ...transformUsageDetails(response.usage),
      },
    };
  }

  return generateInvalidProviderResponseError(response, NCOMPASS);
};

export const NCompassChatCompleteStreamChunkTransform: (response: string) => string = (
  responseChunk,
) => {
  let chunk = responseChunk.trim();
  chunk = chunk.replace(/^data: /, '');
  chunk = chunk.trim();
  if (chunk === '[DONE]') {
    return `data: ${chunk}\n\n`;
  }
  const parsedChunk: NCompassStreamChunk = parseJson(chunk);
  return (
    `data: ${JSON.stringify({
      id: parsedChunk.id,
      object: parsedChunk.object,
      created: parsedChunk.created,
      model: parsedChunk.model,
      provider: NCOMPASS,
      choices: [
        {
          index: parsedChunk.choices[0].index,
          delta: parsedChunk.choices[0].delta,
          finish_reason: parsedChunk.choices[0].finish_reason,
        },
      ],
    })}` + '\n\n'
  );
};
