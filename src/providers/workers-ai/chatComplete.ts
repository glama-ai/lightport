import { WORKERS_AI } from '../../globals';
import { Params } from '../../types/requestBody';
import { parseJson } from '../../utils/parseJson';
import { ChatCompletionResponse, ErrorResponse, ProviderConfig } from '../types';
import { OpenAIErrorResponseTransform } from '../openai/utils';
import { generateInvalidProviderResponseError, transformReasoning } from '../utils';
import { WorkersAiErrorResponse, WorkersAiErrorResponseTransform } from './utils';

export const WorkersAiChatCompleteConfig: ProviderConfig = {
  // Named in the body now rather than in the path, which is what moving to the
  // OpenAI-shaped route changes about the request. Marked required by the same
  // convention the rest of the providers follow, though nothing here enforces
  // it: a request naming no model is refused by Cloudflare rather than by this.
  model: {
    param: 'model',
    required: true,
  },
  messages: {
    param: 'messages',
    default: '',
    transform: (params: Params) => {
      return params.messages?.map((message) => {
        if (message.role === 'developer') return { ...message, role: 'system' };
        return message;
      });
    },
  },
  stream: {
    param: 'stream',
    default: false,
  },
  // Without this a streamed turn cannot be asked to report what it cost, so the
  // usage the new route does return is reachable only when not streaming.
  stream_options: {
    param: 'stream_options',
  },
  max_tokens: {
    param: 'max_tokens',
  },
  max_completion_tokens: {
    param: 'max_tokens',
  },
  temperature: {
    param: 'temperature',
  },
  top_p: {
    param: 'top_p',
  },
  frequency_penalty: {
    param: 'frequency_penalty',
  },
  presence_penalty: {
    param: 'presence_penalty',
  },
  seed: {
    param: 'seed',
  },
  stop: {
    param: 'stop',
  },
  n: {
    param: 'n',
  },
  response_format: {
    param: 'response_format',
  },
  // Workers AI serves models fine-tuned to call tools, and reports the calls
  // back. `tools` was not forwarded and the reply was read for its text alone, so
  // tool calling was unreachable at both ends — and by the gateway's own doing:
  // the route this replaces takes `tools` and reports the calls too. Whether a
  // given model answers with one is the model's business; stripping the parameter
  // decides it here, silently, for all of them. `tool_choice` is not a parameter
  // Cloudflare documents, and is forwarded on the same reasoning: unread is no
  // worse than unsent, and refused says more than either.
  tools: {
    param: 'tools',
  },
  tool_choice: {
    param: 'tool_choice',
  },
};

interface WorkersAiChatCompleteResponse {
  result: {
    response?: string;
    // Reported by the model-in-path route too, and named in its output schema
    // beside the reply. Declaring only `response` is what kept them from being
    // read: the type said there was nothing else there to read.
    tool_calls?: { name: string; arguments: Record<string, unknown> }[];
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  } | null;
  success: boolean;
  errors: string[];
  messages: string[];
}

interface WorkersAiChatCompleteStreamResponse {
  // The route this replaces streams the reply as a string; the OpenAI-shaped one
  // streams deltas, which are forwarded whole.
  response?: string;
  p?: string;
  choices?: any[];
}

export const WorkersAiChatCompleteResponseTransform: (
  response: WorkersAiChatCompleteResponse | WorkersAiErrorResponse,
  responseStatus: number,
  responseHeaders: Headers,
  strictOpenAiCompliance: boolean,
  gatewayRequestUrl: string,
  gatewayRequest: Params,
) => ChatCompletionResponse | ErrorResponse = (
  response,
  responseStatus,
  _responseHeaders,
  strictOpenAiCompliance,
  _gatewayRequestUrl,
  gatewayRequest,
) => {
  // 246 is a success here as it is everywhere else the gateway reads a status.
  const answeredSuccessfully = [200, 246].includes(responseStatus);

  if (!answeredSuccessfully) {
    const errorResponse = WorkersAiErrorResponseTransform(response as WorkersAiErrorResponse);
    if (errorResponse) return errorResponse;

    // Cloudflare's own refusals arrive in its envelope, which the transform above
    // reads. A route answering in OpenAI's shape may refuse in it too, and that
    // shape names no `errors` — so without this the failure reached the caller as
    // an answer that could not be read, with the reason sitting unread inside it.
    if ('error' in response) {
      return OpenAIErrorResponseTransform(response as unknown as ErrorResponse, WORKERS_AI);
    }
  }

  const answered = response as unknown as ChatCompletionResponse;

  // The route answers in the shape the gateway already speaks, so the response is
  // carried whole rather than rebuilt — which is what loses a field nobody
  // thought to name. What is added is the provider and the content block form of
  // any reasoning, the only shape the Responses adapter reads a reasoning turn
  // from when it is not streaming.
  //
  // Only when the status says the turn succeeded. A failure carrying choices and
  // naming its reason somewhere this cannot read is still a failure, and handing
  // it back as an answer is how a caller comes to act on one.
  if (answeredSuccessfully && Array.isArray(answered.choices)) {
    return {
      ...answered,
      provider: WORKERS_AI,
      choices: answered.choices.map((choice) =>
        choice?.message
          ? {
              ...choice,
              message: {
                ...choice.message,
                ...transformReasoning(choice.message, strictOpenAiCompliance),
              },
            }
          : choice,
      ),
    };
  }

  // The shape the route this replaces answers in, kept as a fallback for a custom
  // host mapping this path onto that route. It reports the reply, the usage and
  // any tool call, all of which are read: the gap this change closes is not one
  // worth reopening in the branch kept for compatibility with where it came from.
  // What it has no way to report is the reason for stopping, which is why the
  // finish reason below is derived rather than read.
  if (answeredSuccessfully && 'result' in response && response.result) {
    const { response: text, tool_calls: toolCalls, usage } = response.result;

    return {
      id: Date.now().toString(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: gatewayRequest.model || '',
      provider: WORKERS_AI,
      choices: [
        {
          message: {
            role: 'assistant',
            content: text ?? '',
            // Named and shaped as this route reports them — a name and already
            // parsed arguments — rather than as the OpenAI shape the gateway
            // hands on, so they are given both.
            ...(toolCalls?.length && {
              tool_calls: toolCalls.map((toolCall, index) => ({
                id: `${index}`,
                type: 'function' as const,
                function: {
                  name: toolCall.name,
                  arguments: JSON.stringify(toolCall.arguments ?? {}),
                },
              })),
            }),
          },
          index: 0,
          logprobs: null,
          // The route names no reason, so this says what the reply itself shows:
          // a turn that asked for a tool stopped to ask for it.
          finish_reason: toolCalls?.length ? 'tool_calls' : '',
        },
      ],
      ...(usage && { usage }),
    };
  }

  return generateInvalidProviderResponseError(response, WORKERS_AI);
};

export const WorkersAiChatCompleteStreamChunkTransform: (
  response: string,
  fallbackId: string,
  _streamState: Record<string, boolean>,
  _strictOpenAiCompliance: boolean,
  gatewayRequest: Params,
) => string | undefined = (
  responseChunk,
  fallbackId,
  _streamState,
  _strictOpenAiCompliance,
  gatewayRequest,
) => {
  let chunk = responseChunk.trim();

  if (chunk.startsWith('data: [DONE]')) {
    return 'data: [DONE]\n\n';
  }

  chunk = chunk.replace(/^data: /, '');
  chunk = chunk.trim();

  const parsedChunk: WorkersAiChatCompleteStreamResponse = parseJson(chunk);

  // The OpenAI-shaped route streams deltas the gateway already understands, so
  // they are forwarded whole — rebuilding them as content alone is what drops a
  // tool call, a reasoning field, or the reason the model stopped.
  if (Array.isArray(parsedChunk.choices)) {
    return `data: ${JSON.stringify({ ...parsedChunk, provider: WORKERS_AI })}\n\n`;
  }

  return (
    `data: ${JSON.stringify({
      id: fallbackId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: gatewayRequest.model || '',
      provider: WORKERS_AI,
      choices: [
        {
          delta: {
            content: parsedChunk.response,
          },
          index: 0,
          logprobs: null,
          finish_reason: null,
        },
      ],
    })}` + '\n\n'
  );
};
