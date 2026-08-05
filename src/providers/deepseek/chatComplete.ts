import { DEEPSEEK } from '../../globals';
import { Message, Params } from '../../types/requestBody';
import { parseJson } from '../../utils/parseJson';
import { OpenAIErrorResponseTransform } from '../openai/utils';
import { ChatChoice, ChatCompletionResponse, ErrorResponse, ProviderConfig } from '../types';
import {
  generateErrorResponse,
  generateInvalidProviderResponseError,
  transformFinishReason,
  transformReasoning,
  transformUsageDetails,
} from '../utils';
import { DEEPSEEK_STOP_REASON } from './types';

export const DeepSeekChatCompleteConfig: ProviderConfig = {
  model: {
    param: 'model',
    required: true,
    default: 'deepseek-chat',
  },
  messages: {
    param: 'messages',
    default: '',
    transform: (params: Params) => {
      return params.messages?.map((message: Message) => {
        if (message.role === 'developer') return { ...message, role: 'system' };
        return message;
      });
    },
  },
  response_format: {
    param: 'response_format',
    default: null,
  },
  max_tokens: {
    param: 'max_tokens',
    default: 100,
    min: 0,
  },
  max_completion_tokens: {
    param: 'max_tokens',
    default: 100,
    min: 0,
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
  stream: {
    param: 'stream',
    default: false,
  },
  stream_options: {
    param: 'stream_options',
  },
  frequency_penalty: {
    param: 'frequency_penalty',
    default: 0,
    min: -2,
    max: 2,
  },
  presence_penalty: {
    param: 'presence_penalty',
    default: 0,
    min: -2,
    max: 2,
  },
  stop: {
    param: 'stop',
    default: null,
  },
  logprobs: {
    param: 'logprobs',
    default: false,
  },
  top_logprobs: {
    param: 'top_logprobs',
    default: 0,
    min: 0,
    max: 20,
  },
  tools: {
    param: 'tools',
  },
  tool_choice: {
    param: 'tool_choice',
  },
  thinking: {
    param: 'thinking',
  },
};

interface DeepSeekUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
}

interface DeepSeekChatCompleteResponse extends ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: 'deepseek-chat' | 'deepseek-coder';
  choices: (ChatChoice & {
    message: Message & {
      reasoning_content?: string | null;
    };
  })[];
  usage: DeepSeekUsage;
}

export interface DeepSeekErrorResponse {
  object: string;
  message: string;
  type: string;
  param: string | null;
  code: string;
}

interface DeepSeekStreamChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  usage?: DeepSeekUsage;
  choices: {
    delta: {
      role?: string | null;
      content?: string;
      // Forwarded whole below, so this reaches the caller already. It is spelled
      // out because the non-streaming transform rebuilds the message instead,
      // and left this out for as long as nothing said it was here.
      reasoning_content?: string;
      tool_calls?: any[];
    };
    index: number;
    finish_reason: string | null;
  }[];
}

export const DeepSeekChatCompleteResponseTransform: (
  response: DeepSeekChatCompleteResponse | DeepSeekErrorResponse | ErrorResponse,
  responseStatus: number,
  responseHeaders: Headers,
  strictOpenAiCompliance: boolean,
) => ChatCompletionResponse | ErrorResponse = (
  response,
  responseStatus,
  _responseHeaders,
  strictOpenAiCompliance,
) => {
  // DeepSeek nests its errors the way OpenAI does, under `error`. Only the flat
  // shape was recognised, so a real refusal — a bad key, a rate limit — fell
  // through to the invalid-response branch below and reached the caller as
  // "Invalid response received from deepseek", with the provider's own message,
  // type and code sitting in the payload unread.
  if (responseStatus !== 200 && 'error' in response) {
    return OpenAIErrorResponseTransform(response as ErrorResponse, DEEPSEEK);
  }

  if ('message' in response && responseStatus !== 200) {
    return generateErrorResponse(
      {
        message: response.message,
        type: response.type,
        param: response.param,
        code: response.code,
      },
      DEEPSEEK,
    );
  }

  if ('choices' in response) {
    return {
      id: response.id,
      object: response.object,
      created: response.created,
      model: response.model,
      provider: DEEPSEEK,
      choices: response.choices.map((c) => ({
        index: c.index,
        message: {
          role: c.message.role,
          content: c.message.content,
          ...transformReasoning(c.message, strictOpenAiCompliance),
          ...(c.message.tool_calls && { tool_calls: c.message.tool_calls }),
        },
        // Requested through `logprobs`/`top_logprobs`, which this provider
        // accepts, and then discarded on the way back.
        ...(c.logprobs !== undefined && { logprobs: c.logprobs }),
        finish_reason: transformFinishReason(
          c.finish_reason as DEEPSEEK_STOP_REASON,
          strictOpenAiCompliance,
        ),
      })),
      usage: {
        prompt_tokens: response.usage?.prompt_tokens,
        completion_tokens: response.usage?.completion_tokens,
        total_tokens: response.usage?.total_tokens,
        ...transformUsageDetails(response.usage),
      },
    };
  }

  return generateInvalidProviderResponseError(response, DEEPSEEK);
};

export const DeepSeekChatCompleteStreamChunkTransform: (
  response: string,
  fallbackId: string,
  streamState: any,
  strictOpenAiCompliance: boolean,
) => string | string[] = (responseChunk, fallbackId, _streamState, strictOpenAiCompliance) => {
  let chunk = responseChunk.trim();
  chunk = chunk.replace(/^data: /, '');
  chunk = chunk.trim();
  if (chunk === '[DONE]') {
    return `data: ${chunk}\n\n`;
  }
  const parsedChunk: DeepSeekStreamChunk = parseJson(chunk);
  const finishReason = parsedChunk.choices[0].finish_reason
    ? transformFinishReason(
        parsedChunk.choices[0].finish_reason as DEEPSEEK_STOP_REASON,
        strictOpenAiCompliance,
      )
    : null;
  return (
    `data: ${JSON.stringify({
      id: parsedChunk.id,
      object: parsedChunk.object,
      created: parsedChunk.created,
      model: parsedChunk.model,
      provider: DEEPSEEK,
      choices: [
        {
          index: parsedChunk.choices[0].index,
          delta: parsedChunk.choices[0].delta,
          finish_reason: finishReason,
        },
      ],
      usage: parsedChunk.usage,
    })}` + '\n\n'
  );
};
