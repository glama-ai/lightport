import { getOrGenerateId } from '../../utils/idGenerator';

type GeminiPart = {
  text?: string;
  thought?: string | boolean;
  functionCall?: { name: string; args: Record<string, any> };
  inlineData?: { mimeType: string; data: string };
  thoughtSignature?: string;
};

type GeminiCandidate = {
  content?: { parts?: GeminiPart[] };
  finishMessage?: string;
};

/**
 * What a Gemini stream remembers between chunks. Created empty by the stream
 * handler and handed to every chunk of the one response.
 */
export type GeminiStreamState = {
  containsChainOfThoughtMessage?: boolean;
  hasToolCalls?: boolean;
  /** How many tool calls each candidate has streamed so far, by candidate index. */
  toolCallCount?: Record<number, number>;
};

/**
 * The delta one candidate of a streamed Gemini chunk stands for.
 *
 * Every part is read, whatever kind came first. The chunk used to be read as
 * whichever kind its first part was, and only as that: a reply that thought or
 * spoke before calling a tool in the same chunk — `[thought, functionCall]`,
 * `[text, functionCall]` — lost the call and finished as `stop`, while one that
 * called first and then spoke sent `tool_calls: [{…}, null]`, the text mapped to
 * nothing, which the Responses adapter could not read past.
 *
 * A tool call is numbered by its place in the whole response, not in the chunk.
 * OpenAI's clients assemble calls by that index, so two calls arriving in
 * different chunks, each numbered 0, became one call with both sets of
 * arguments run together.
 */
export const geminiStreamDelta = (
  candidate: GeminiCandidate,
  candidateIndex: number,
  streamState: GeminiStreamState,
  strictOpenAiCompliance: boolean,
): Record<string, unknown> => {
  const toolCallCount = (streamState.toolCallCount ??= {});
  const contentBlocks: Record<string, unknown>[] = [];
  const toolCalls: Record<string, unknown>[] = [];
  let content = '';
  let hasText = false;
  let hasImage = false;

  for (const part of candidate.content?.parts ?? []) {
    if (part.functionCall) {
      const index = toolCallCount[candidateIndex] ?? 0;
      toolCallCount[candidateIndex] = index + 1;

      toolCalls.push({
        index,
        id: getOrGenerateId(undefined, 'toolCall'),
        type: 'function',
        function: {
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args),
          ...(!strictOpenAiCompliance &&
            part.thoughtSignature && { thought_signature: part.thoughtSignature }),
        },
      });
    } else if (part.inlineData) {
      // Sent whatever the compliance setting, as before: an image has no other
      // place in a chat completion to go.
      hasImage = true;
      contentBlocks.push({
        index: streamState.containsChainOfThoughtMessage ? 1 : 0,
        delta: {
          type: 'image_url',
          image_url: { url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}` },
        },
      });
    } else if (part.thought) {
      if (!strictOpenAiCompliance) {
        contentBlocks.push({ index: 0, delta: { thinking: part.text } });
      }
      streamState.containsChainOfThoughtMessage = true;
    } else if (typeof part.text === 'string') {
      hasText = true;
      content += part.text;
      if (!strictOpenAiCompliance) {
        contentBlocks.push({
          index: streamState.containsChainOfThoughtMessage ? 1 : 0,
          delta: { text: part.text },
        });
      }
    }
  }

  if (toolCalls.length) {
    streamState.hasToolCalls = true;
  }

  const message: Record<string, unknown> = { role: 'assistant' };

  if (hasText) {
    message.content = content;
  } else if (!toolCalls.length && !hasImage) {
    // Nothing said, so say why if Gemini did — a MALFORMED_FUNCTION_CALL ends
    // with its reason here and no parts at all.
    message.content = candidate.finishMessage ?? '';
  }

  if (toolCalls.length) {
    message.tool_calls = toolCalls;
  }

  if (contentBlocks.length) {
    message.content_blocks = contentBlocks;
  }

  return message;
};
