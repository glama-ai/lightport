/**
 * Stream Transform for Messages API Adapter
 *
 * Transforms Chat Completions SSE chunks to Anthropic Messages API SSE format.
 */

import { readOpenAiErrorEvent } from '../../errors/openAiError';
import { captureException } from '../../sentry/captureException';
import { parseJson } from '../../utils/parseJson';
import { randomUUID } from 'crypto';

interface StreamState {
  messageId: string;
  model: string;
  hasStarted: boolean;
  completed: boolean;
  inputTokens: number;
  outputTokens: number;
  contentBlockIndex: number;
  stopReason: string | null;
  // Blocks are numbered as they are opened rather than at fixed positions. The
  // text block used to be opened at index 0 before the model had said anything,
  // which left nowhere for the thinking to go: Anthropic orders thinking ahead
  // of the answer, and the non-streaming half of this adapter already does.
  //
  // Anthropic has one block open at a time — start, its deltas, stop, then the
  // next — so a single index is tracked, and opening anything closes whatever
  // was open. Blocks used to be left open while later ones were started inside
  // them, which a caller following the current block reads as the wrong content.
  thinkingIndex: number | null;
  textIndex: number | null;
  openIndex: number | null;
  // One slot per tool-call index, which is what the chunks continuing a call
  // carry. The id is held only to notice a different call reusing the index.
  toolSlots: Record<number, { id?: string; blockIndex?: number; pending: string }>;
}

const contentBlockStop = (index: number) =>
  `event: content_block_stop\ndata: ${JSON.stringify({
    type: 'content_block_stop',
    index,
  })}\n\n`;

// Closes the open block, if there is one, and forgets whichever index pointed at
// it, so the next thing the model says opens a block of its own rather than
// writing into one already stopped.
const closeOpenBlock = (state: StreamState): string[] => {
  const index = state.openIndex;

  if (index === null) return [];

  state.openIndex = null;
  if (state.thinkingIndex === index) state.thinkingIndex = null;
  if (state.textIndex === index) state.textIndex = null;

  return [contentBlockStop(index)];
};

// The same, at the end of the stream, where nothing more will be written and
// every index is forgotten — a provider that repeats the finish reason on each
// chunk would otherwise carry on writing into blocks that have been closed.
const drainOpenBlocks = (state: StreamState): string[] => {
  const events = closeOpenBlock(state);

  state.thinkingIndex = null;
  state.textIndex = null;
  for (const slot of Object.values(state.toolSlots)) slot.blockIndex = undefined;

  return events;
};

const toolArgumentsDelta = (index: number, partialJson: string) =>
  `event: content_block_delta\ndata: ${JSON.stringify({
    type: 'content_block_delta',
    index,
    delta: { type: 'input_json_delta', partial_json: partialJson },
  })}\n\n`;

/**
 * Transform a single Chat Completions stream chunk to Messages API stream events
 */
export function transformStreamChunk(chunk: string, state: StreamState): string | undefined {
  const trimmed = chunk.trim();

  // Nothing follows a failure. An upstream that kept talking would otherwise
  // open a second message here — `message_start` and all — behind an error that
  // has already been sent, and nothing would ever close it.
  //
  // Ahead of the error check below, because an error is a later chunk too: one
  // arriving after `message_stop` would otherwise raise at a caller whose
  // message had already ended cleanly.
  if (state.completed) {
    return undefined;
  }

  // An upstream failure, already flagged as one by the provider transform.
  // Messages has its own error event, so it passes through as an error rather
  // than being dropped for want of a `data:` line — and marking the message
  // finished stops the `[DONE]` flush below closing it as `end_turn`, which
  // would tell the caller the model had answered.
  const upstreamError = readOpenAiErrorEvent(trimmed);

  if (upstreamError) {
    state.completed = true;

    return `event: error\ndata: ${JSON.stringify({
      error: {
        message: upstreamError.message,
        // Anthropic's own error object always names a type, so one is supplied
        // rather than dropped by JSON.stringify for being undefined.
        type: upstreamError.type ?? 'api_error',
      },
      type: 'error',
    })}\n\n`;
  }

  // Handle [DONE]
  if (trimmed === 'data: [DONE]') {
    if (!state.hasStarted || state.completed) return undefined;
    state.completed = true;

    // Emit message_delta and message_stop
    return [
      // A message that said nothing still carried an empty text block before, so
      // one is sent rather than closing the message with no content at all — as
      // the finish-reason path below also does.
      ...(state.contentBlockIndex === 0
        ? [
            `event: content_block_start\ndata: ${JSON.stringify({
              type: 'content_block_start',
              index: state.contentBlockIndex++,
              content_block: { type: 'text', text: '' },
            })}\n\n`,
            contentBlockStop(0),
          ]
        : []),
      // A stream whose last chunk carried no finish reason ended with its blocks
      // still open, so the caller was told the message had stopped while a block
      // inside it never had.
      ...drainOpenBlocks(state),
      `event: message_delta\ndata: ${JSON.stringify({
        type: 'message_delta',
        delta: {
          stop_reason: state.stopReason || 'end_turn',
          stop_sequence: null,
        },
        usage: {
          output_tokens: state.outputTokens,
          input_tokens: state.inputTokens,
        },
      })}\n\n`,
      `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
    ].join('');
  }

  // Skip non-data lines
  if (!trimmed || !trimmed.startsWith('data: ')) return undefined;

  // Parse the chunk
  let parsed: any;
  try {
    parsed = parseJson(trimmed.slice(6));
  } catch (error) {
    captureException({
      error,
      extra: { chunk: trimmed.slice(0, 500) },
      message: 'failed to parse chat completions chunk in messages stream transform',
    });

    return undefined;
  }

  const events: string[] = [];

  // Initialize on first chunk
  if (!state.hasStarted) {
    state.hasStarted = true;
    state.messageId = `msg_${randomUUID()}`;
    state.model = parsed.model || '';

    // Emit message_start
    events.push(
      `event: message_start\ndata: ${JSON.stringify({
        type: 'message_start',
        message: {
          id: state.messageId,
          type: 'message',
          role: 'assistant',
          content: [],
          model: state.model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: state.inputTokens, output_tokens: 0 },
        },
      })}\n\n`,
    );
  }

  const delta = parsed.choices?.[0]?.delta;

  // Opens a block at the next free index, closing whatever was open first, so a
  // block is never opened inside another and a delta never follows its own stop.
  // The model is free to think again after it has begun answering, or to speak
  // between two tool calls, and simply gets another block when it does.
  const openBlock = (contentBlock: Record<string, unknown>): number => {
    events.push(...closeOpenBlock(state));

    const index = state.contentBlockIndex++;
    state.openIndex = index;
    events.push(
      `event: content_block_start\ndata: ${JSON.stringify({
        type: 'content_block_start',
        index,
        content_block: contentBlock,
      })}\n\n`,
    );

    return index;
  };

  // Thinking arrives either as `reasoning_content`, which is how the providers
  // speaking OpenAI's dialect stream it, or as `content_blocks` from a provider
  // whose transform already reshaped it. Neither was read here at all, so a
  // streamed reasoner reached this API with its thinking missing while the same
  // model answering without a stream did not. `content_blocks` wins where a
  // provider sends both, so the reasoning is not counted twice.
  let thinking = '';

  if (Array.isArray(delta?.content_blocks)) {
    for (const block of delta.content_blocks) {
      const text = block?.delta?.thinking ?? block?.thinking;
      if (typeof text === 'string' && text) thinking += text;
    }
  }

  if (!thinking && typeof delta?.reasoning_content === 'string') {
    thinking = delta.reasoning_content;
  }

  if (thinking) {
    if (state.thinkingIndex === null) {
      // `signature` is empty rather than absent, as the non-streaming half of
      // this adapter already sends it, so the two agree on the block's shape.
      state.thinkingIndex = openBlock({ type: 'thinking', thinking: '', signature: '' });
    }

    events.push(
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: 'content_block_delta',
        index: state.thinkingIndex,
        delta: { type: 'thinking_delta', thinking },
      })}\n\n`,
    );
  }

  // Handle content delta
  if (delta?.content) {
    if (state.textIndex === null) {
      state.textIndex = openBlock({ type: 'text', text: '' });
    }

    events.push(
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: 'content_block_delta',
        index: state.textIndex,
        delta: { type: 'text_delta', text: delta.content },
      })}\n\n`,
    );
  }

  // Handle tool calls
  if (delta?.tool_calls) {
    for (const tc of delta.tool_calls) {
      // A call is followed by its index, which is the only thing the chunks
      // continuing it carry. A different id at the same index is a different
      // call, though — some providers number the calls within a chunk from
      // zero, so a second call in a later chunk arrives as index 0 again.
      const callIndex = tc.index ?? 0;
      const existing = state.toolSlots[callIndex];

      if (!existing || (tc.id && existing.id && existing.id !== tc.id)) {
        state.toolSlots[callIndex] = { id: tc.id, pending: '' };
      }

      const slot = state.toolSlots[callIndex];
      if (tc.id) slot.id = tc.id;

      // Opened once per call: a provider repeating the name on every chunk would
      // otherwise get a block each time, splitting one call's arguments into
      // several pieces of invalid JSON.
      if (tc.function?.name && slot.blockIndex === undefined) {
        slot.blockIndex = openBlock({
          type: 'tool_use',
          id: tc.id || `toolu_${randomUUID()}`,
          name: tc.function.name,
          input: {},
        });

        // Arguments can arrive before the call is named. They used to be
        // dropped, so the tool ran on an empty input with nothing to say it had
        // been given one; they are held until there is a block to put them in.
        if (slot.pending) {
          events.push(toolArgumentsDelta(slot.blockIndex, slot.pending));
          slot.pending = '';
        }
      }

      if (tc.function?.arguments) {
        if (slot.blockIndex === undefined) {
          slot.pending += tc.function.arguments;
        } else {
          events.push(toolArgumentsDelta(slot.blockIndex, tc.function.arguments));
        }
      }
    }
  }

  // Track usage
  if (parsed.usage) {
    state.inputTokens = parsed.usage.prompt_tokens || state.inputTokens;
    state.outputTokens = parsed.usage.completion_tokens || state.outputTokens;
  }

  // Track stop reason
  if (parsed.choices?.[0]?.finish_reason) {
    const reason = parsed.choices[0].finish_reason;
    state.stopReason =
      reason === 'tool_calls' ? 'tool_use' : reason === 'length' ? 'max_tokens' : 'end_turn';

    // A message that said nothing still carried an empty text block before, so
    // one is opened here rather than closing the message with no content at all.
    if (state.contentBlockIndex === 0) {
      state.textIndex = openBlock({ type: 'text', text: '' });
    }

    // Every block that was opened, not only the first: the tool_use blocks used
    // to be left open, and a thinking block would have been too.
    events.push(...drainOpenBlocks(state));
  }

  return events.length > 0 ? events.join('') : undefined;
}

/**
 * Create initial stream state
 */
export function createStreamState(): StreamState {
  return {
    messageId: '',
    model: '',
    hasStarted: false,
    completed: false,
    inputTokens: 0,
    outputTokens: 0,
    contentBlockIndex: 0,
    stopReason: null,
    thinkingIndex: null,
    textIndex: null,
    openIndex: null,
    toolSlots: {},
  };
}
