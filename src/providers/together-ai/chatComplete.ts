import { TOGETHER_AI } from '../../globals';
import { Message, Params } from '../../types/requestBody';
import { parseJson } from '../../utils/parseJson';
import { ChatCompletionResponse, ErrorResponse, ProviderConfig } from '../types';
import {
  generateErrorResponse,
  generateInvalidProviderResponseError,
  transformFinishReason,
  transformUsageDetails,
} from '../utils';
import { TOGETHER_AI_FINISH_REASON } from './types';

// TODOS: this configuration does not enforce the maximum token limit for the input parameter. If you want to enforce this, you might need to add a custom validation function or a max property to the ParameterConfig interface, and then use it in the input configuration. However, this might be complex because the token count is not a simple length check, but depends on the specific tokenization method used by the model.

export const TogetherAIChatCompleteConfig: ProviderConfig = {
  model: {
    param: 'model',
    required: true,
    default: 'meta-llama/Llama-3.2-11B-Vision-Instruct-Turbo',
  },
  messages: {
    param: 'messages',
    required: true,
    default: '',
    transform: (params: Params) => {
      return params.messages?.map((message: Message) => {
        if (message.role === 'developer') return { ...message, role: 'system' };
        return message;
      });
    },
  },
  max_tokens: {
    param: 'max_tokens',
    required: true,
    default: 128,
    min: 1,
  },
  max_completion_tokens: {
    param: 'max_tokens',
    default: 128,
    min: 1,
  },
  stop: {
    param: 'stop',
  },
  temperature: {
    param: 'temperature',
  },
  top_p: {
    param: 'top_p',
  },
  top_k: {
    param: 'top_k',
  },
  frequency_penalty: {
    param: 'repetition_penalty',
  },
  stream: {
    param: 'stream',
    default: false,
  },
  logprobs: {
    param: 'logprobs',
  },
  tools: {
    param: 'tools',
  },
  tool_choice: {
    param: 'tool_choice',
  },
  response_format: {
    param: 'response_format',
  },
  reasoning_effort: {
    param: 'reasoning_effort',
  },
};

interface TogetherAIMessage {
  role: string;
  content: string;
  reasoning?: string;
  reasoning_content?: string;
  tool_calls?: {
    id: string;
    type: string;
    function: {
      name: string;
      arguments: string;
    };
  }[];
}

interface TogetherAIChoice {
  index: number;
  message: TogetherAIMessage;
  logprobs?: object | null;
  finish_reason: TOGETHER_AI_FINISH_REASON;
}

export interface TogetherAIChatCompleteResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: TogetherAIChoice[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    completion_tokens_details?: Record<string, number>;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

export interface TogetherAIErrorResponse {
  model: string;
  job_id: string;
  request_id: string;
  error: string;
  message?: string;
  type?: string;
}

export interface TogetherAIOpenAICompatibleErrorResponse extends ErrorResponse {}

export interface TogetherAIChatCompletionStreamChunk {
  id: string;
  model: string;
  request_id: string;
  object: string;
  choices: {
    index: number;
    delta: {
      content?: string;
      reasoning?: string;
      reasoning_content?: string;
    };
    finish_reason: TOGETHER_AI_FINISH_REASON;
  }[];
}

export const TogetherAIErrorResponseTransform: (
  response: TogetherAIErrorResponse | TogetherAIOpenAICompatibleErrorResponse,
) => ErrorResponse | false = (response) => {
  if ('error' in response && typeof response.error === 'string') {
    return generateErrorResponse(
      { message: response.error, type: null, param: null, code: null },
      TOGETHER_AI,
    );
  }

  if ('error' in response && typeof response.error === 'object') {
    return generateErrorResponse(
      {
        message: response.error?.message || '',
        type: response.error?.type || null,
        param: response.error?.param || null,
        code: response.error?.code || null,
      },
      TOGETHER_AI,
    );
  }

  if ('message' in response && response.message) {
    return generateErrorResponse(
      {
        message: response.message,
        type: response.type || null,
        param: null,
        code: null,
      },
      TOGETHER_AI,
    );
  }

  return false;
};

export const TogetherAIChatCompleteResponseTransform: (
  response:
    | TogetherAIChatCompleteResponse
    | TogetherAIErrorResponse
    | TogetherAIOpenAICompatibleErrorResponse,
  responseStatus: number,
  responseHeaders: Headers,
  strictOpenAiCompliance: boolean,
) => ChatCompletionResponse | ErrorResponse = (
  response,
  responseStatus,
  _responseHeaders,
  strictOpenAiCompliance,
) => {
  if (responseStatus !== 200) {
    const errorResponse = TogetherAIErrorResponseTransform(response as TogetherAIErrorResponse);
    if (errorResponse) return errorResponse;
  }

  if ('choices' in response) {
    return {
      id: response.id,
      object: response.object,
      created: response.created,
      model: response.model,
      provider: TOGETHER_AI,
      choices: response.choices.map((choice) => {
        const content_blocks = [];
        // Together hosts models from both camps, so the thinking arrives under
        // whichever name the model it is serving happens to use.
        const reasoning = choice.message.reasoning_content || choice.message.reasoning;

        if (!strictOpenAiCompliance) {
          if (reasoning) {
            content_blocks.push({
              type: 'thinking',
              thinking: reasoning,
            });
          }

          content_blocks.push({
            type: 'text',
            text: choice.message.content,
          });
        }

        return {
          message: {
            role: 'assistant',
            content: choice.message.content,
            // The thinking was rebuilt into `content_blocks` above but the field
            // it arrived in was dropped, so a caller reading the reasoning the
            // way the model reported it found nothing there.
            ...(reasoning && { reasoning_content: reasoning }),
            ...(content_blocks.length && { content_blocks }),
            tool_calls: choice.message.tool_calls
              ? choice.message.tool_calls.map((toolCall: any) => ({
                  id: toolCall.id,
                  type: toolCall.type,
                  function: toolCall.function,
                }))
              : null,
          },
          index: choice.index,
          // Was hardcoded to null while `logprobs` is accepted as a request
          // parameter, so what was asked for was thrown away on return.
          logprobs: choice.logprobs ?? null,
          finish_reason: transformFinishReason(choice.finish_reason, strictOpenAiCompliance),
        };
      }),
      usage: {
        prompt_tokens: response.usage?.prompt_tokens,
        completion_tokens: response.usage?.completion_tokens,
        total_tokens: response.usage?.total_tokens,
        ...transformUsageDetails(response.usage),
      },
    };
  }

  return generateInvalidProviderResponseError(response, TOGETHER_AI);
};

export const TogetherAIChatCompleteStreamChunkTransform: (
  response: string,
  fallbackId: string,
  streamState: any,
  strictOpenAiCompliance: boolean,
) => string = (responseChunk, fallbackId, streamState, strictOpenAiCompliance) => {
  let chunk = responseChunk.trim();
  chunk = chunk.replace(/^data: /, '');
  chunk = chunk.trim();
  if (chunk === '[DONE]') {
    return `data: ${chunk}\n\n`;
  }
  const parsedChunk: TogetherAIChatCompletionStreamChunk = parseJson(chunk);
  const finishReason = parsedChunk.choices[0]?.finish_reason
    ? transformFinishReason(parsedChunk.choices[0].finish_reason, strictOpenAiCompliance)
    : null;

  // Read under both names, as the non-streaming half does: the stream looked
  // only for `reasoning`, so a Together-hosted model using the other name lost
  // its thinking here while the other path kept it.
  const reasoning =
    parsedChunk.choices?.[0]?.delta?.reasoning_content ||
    parsedChunk.choices?.[0]?.delta?.reasoning;

  const content_blocks = [];
  if (!strictOpenAiCompliance) {
    // Add reasoning first
    if (reasoning) {
      content_blocks.push({
        index: parsedChunk.choices?.[0]?.index,
        delta: {
          thinking: reasoning,
        },
      });
    }
    // Then add content
    if (parsedChunk.choices?.[0]?.delta?.content) {
      content_blocks.push({
        index: parsedChunk.choices?.[0]?.index,
        delta: {
          text: parsedChunk.choices?.[0]?.delta?.content,
        },
      });
    }
  }

  return (
    `data: ${JSON.stringify({
      id: parsedChunk.id,
      object: parsedChunk.object,
      created: Math.floor(Date.now() / 1000),
      model: parsedChunk.model,
      provider: TOGETHER_AI,
      choices: [
        {
          delta: {
            content: parsedChunk.choices[0]?.delta?.content,
            // Forwarded so the two paths agree on what the model said: the
            // non-streaming half reports the thinking here whatever the
            // compliance setting, and this half reported it nowhere.
            ...(reasoning && { reasoning_content: reasoning }),
            ...(content_blocks.length && { content_blocks }),
          },
          index: parsedChunk.choices?.[0]?.index ?? 0,
          finish_reason: finishReason,
        },
      ],
    })}` + '\n\n'
  );
};
