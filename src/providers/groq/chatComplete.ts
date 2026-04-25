import { GROQ } from '../../globals';
import { parseJson } from '../../utils/parseJson';

export interface GroqStreamChunkUsage {
  queue_time: number;
  prompt_tokens: number;
  prompt_time: number;
  completion_tokens: number;
  completion_time: number;
  total_tokens: number;
  total_time: number;
}

export interface GroqStreamChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: {
    delta: {
      content?: string;
      tool_calls?: object[];
    };
    index: number;
    finish_reason: string | null;
    logprobs: object | null;
  }[];
  x_groq: {
    usage: GroqStreamChunkUsage;
  };
  usage: GroqStreamChunkUsage;
}

export const GroqChatCompleteStreamChunkTransform: (response: string) => string = (
  responseChunk,
) => {
  let chunk = responseChunk.trim();
  chunk = chunk.replace(/^data: /, '');
  chunk = chunk.trim();
  if (chunk === '[DONE]') {
    return `data: ${chunk}\n\n`;
  }

  const parsedChunk: GroqStreamChunk = parseJson(chunk);
  if (parsedChunk['x_groq'] && parsedChunk['x_groq'].usage) {
    return `data: ${JSON.stringify({
      id: parsedChunk.id,
      object: parsedChunk.object,
      created: parsedChunk.created,
      model: parsedChunk.model,
      provider: GROQ,
      choices: [
        {
          index: parsedChunk.choices[0].index || 0,
          delta: {},
          logprobs: null,
          finish_reason: parsedChunk.choices[0].finish_reason,
        },
      ],
      usage: {
        prompt_tokens: parsedChunk['x_groq'].usage.prompt_tokens || 0,
        completion_tokens: parsedChunk['x_groq'].usage.completion_tokens || 0,
        total_tokens: parsedChunk['x_groq'].usage.total_tokens || 0,
      },
    })}\n\n`;
  }
  return `data: ${JSON.stringify({
    id: parsedChunk.id,
    object: parsedChunk.object,
    created: parsedChunk.created,
    model: parsedChunk.model,
    provider: GROQ,
    choices:
      parsedChunk.choices && parsedChunk.choices.length > 0
        ? [
            {
              index: parsedChunk.choices[0].index || 0,
              delta: {
                role: 'assistant',
                content: parsedChunk.choices[0].delta?.content || '',
                tool_calls: parsedChunk.choices[0].delta?.tool_calls || [],
              },
              logprobs: null,
              finish_reason: parsedChunk.choices[0].finish_reason || null,
            },
          ]
        : [],
    usage: parsedChunk.usage
      ? {
          prompt_tokens: parsedChunk.usage.prompt_tokens || 0,
          completion_tokens: parsedChunk.usage.completion_tokens || 0,
          total_tokens: parsedChunk.usage.total_tokens || 0,
        }
      : undefined,
  })}\n\n`;
};
