import { SAMBANOVA } from '../../globals';
import { parseJson } from '../../utils/parseJson';

export interface SambaNovaStreamChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  system_fingerprint: string;
  choices: {
    delta: {
      content?: string;
    };
    index: number;
    finish_reason: string | null;
    logprobs: object | null;
  }[];
  usage?: {
    is_last_response: boolean;
    total_tokens: number;
    prompt_tokens: number;
    completion_tokens: number;
    time_to_first_token: number;
    end_time: number;
    start_time: number;
    total_latency: number;
    total_tokens_per_sec: number;
    completion_tokens_per_sec: number;
    completion_tokens_after_first_per_sec: number;
    completion_tokens_after_first_per_sec_first_ten: number;
  };
}

// SambaNova separates its events with a single newline, so the stream is read
// on `\n` rather than `\n\n`. Without a transform each part is handed on with
// the separator it was split by put back, which is not the blank line SSE ends
// an event with — the caller receives a body no event parser will read, and not
// even the `[DONE]` that would end it. The event is re-framed and otherwise left
// exactly as SambaNova wrote it, which for completions is already the shape the
// caller expects.
export const SambaNovaCompleteStreamChunkTransform: (response: string) => string = (
  responseChunk,
) => `${responseChunk.trim()}\n\n`;

export const SambaNovaChatCompleteStreamChunkTransform: (response: string) => string = (
  responseChunk,
) => {
  let chunk = responseChunk.trim();
  chunk = chunk.replace(/^data: /, '');
  chunk = chunk.trim();
  if (chunk === '[DONE]') {
    return `data: ${chunk}\n\n`;
  }

  const parsedChunk: SambaNovaStreamChunk = parseJson(chunk);
  if (parsedChunk.usage) {
    return `data: ${JSON.stringify({
      id: parsedChunk.id,
      object: parsedChunk.object,
      created: parsedChunk.created,
      model: parsedChunk.model,
      provider: SAMBANOVA,
      choices: [
        {
          index: 0,
          delta: {},
          logprobs: null,
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: parsedChunk.usage.prompt_tokens || 0,
        completion_tokens: parsedChunk.usage.completion_tokens || 0,
        total_tokens: parsedChunk.usage.total_tokens || 0,
      },
    })}\n\n`;
  }
  return `data: ${JSON.stringify({
    id: parsedChunk.id,
    object: parsedChunk.object,
    created: parsedChunk.created,
    model: parsedChunk.model,
    provider: SAMBANOVA,
    choices: [
      {
        index: parsedChunk.choices[0].index || 0,
        delta: {
          role: 'assistant',
          content: parsedChunk.choices[0].delta.content,
        },
        logprobs: parsedChunk.choices[0].logprobs,
        finish_reason: parsedChunk.choices[0].finish_reason || null,
      },
    ],
  })}\n\n`;
};
