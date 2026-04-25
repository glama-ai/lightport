/**
 * Stream Transform for Responses API Adapter
 *
 * Transforms Chat Completions SSE chunks to Responses API SSE chunks in real-time.
 * This enables streaming support for providers that only support Chat Completions.
 */

import { captureException } from '../../sentry/captureException';
import { parseJson } from '../../utils/parseJson';
import { randomUUID } from 'crypto';

interface ToolCallState {
  itemId: string;
  callId: string;
  name: string;
  arguments: string;
  outputIndex: number;
}

interface StreamState {
  responseId: string;
  outputItemId: string;
  reasoningItemId: string | null;
  accumulatedReasoningText: string;
  contentPartIndex: number;
  hasStarted: boolean;
  hasEmittedReasoningItem: boolean;
  hasEmittedTextOutputItem: boolean;
  completed: boolean;
  model: string;
  inputTokens: number;
  outputTokens: number;
  finishReason: string | null;
  sequenceNumber: number;
  accumulatedText: string;
  createdAt: number;
  toolCalls: Map<number, ToolCallState>;
}

/**
 * Build a complete response snapshot with all required fields
 */
function buildResponseSnapshot(
  state: StreamState,
  status: 'in_progress' | 'completed' | 'incomplete',
  includeOutput: boolean = false,
  finalText?: string,
): any {
  const output: any[] = [];

  if (includeOutput) {
    if (state.reasoningItemId && state.accumulatedReasoningText) {
      output.push({
        id: state.reasoningItemId,
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: state.accumulatedReasoningText }],
      });
    }

    if (state.hasEmittedTextOutputItem) {
      output.push({
        id: state.outputItemId,
        type: 'message',
        role: 'assistant',
        status: status === 'in_progress' ? 'in_progress' : 'completed',
        content: [
          {
            type: 'output_text',
            text: finalText ?? state.accumulatedText,
            annotations: [],
            logprobs: [],
          },
        ],
      });
    }

    for (const tc of state.toolCalls.values()) {
      output.push({
        id: tc.itemId,
        type: 'function_call',
        call_id: tc.callId,
        name: tc.name,
        arguments: tc.arguments,
        status: 'completed',
      });
    }
  }

  return {
    id: state.responseId,
    object: 'response',
    created_at: state.createdAt,
    completed_at: status === 'completed' ? Math.floor(Date.now() / 1000) : null,
    status,
    incomplete_details: status === 'incomplete' ? { reason: 'max_output_tokens' } : null,
    model: state.model,
    previous_response_id: null,
    instructions: null,
    output,
    error: null,
    tools: [],
    tool_choice: 'auto',
    truncation: 'disabled',
    parallel_tool_calls: true,
    text: { format: { type: 'text' } },
    top_p: 1,
    presence_penalty: 0,
    frequency_penalty: 0,
    top_logprobs: 0,
    temperature: 1,
    reasoning: null,
    usage: {
      input_tokens: state.inputTokens,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: state.outputTokens,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: state.inputTokens + state.outputTokens,
    },
    max_output_tokens: null,
    max_tool_calls: null,
    store: false,
    background: false,
    service_tier: 'default',
    metadata: {},
    safety_identifier: null,
    prompt_cache_key: null,
  };
}

/**
 * Emit text output completion events
 */
function buildTextCompletionEvents(state: StreamState): string[] {
  const finalText = state.accumulatedText;
  return [
    `event: response.output_text.done\ndata: ${JSON.stringify({
      type: 'response.output_text.done',
      sequence_number: state.sequenceNumber++,
      item_id: state.outputItemId,
      output_index: 0,
      content_index: state.contentPartIndex,
      text: finalText,
      logprobs: [],
    })}\n\n`,
    `event: response.content_part.done\ndata: ${JSON.stringify({
      type: 'response.content_part.done',
      sequence_number: state.sequenceNumber++,
      item_id: state.outputItemId,
      output_index: 0,
      content_index: state.contentPartIndex,
      part: {
        type: 'output_text',
        text: finalText,
        annotations: [],
        logprobs: [],
      },
    })}\n\n`,
    `event: response.output_item.done\ndata: ${JSON.stringify({
      type: 'response.output_item.done',
      sequence_number: state.sequenceNumber++,
      output_index: 0,
      item: {
        id: state.outputItemId,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [
          {
            type: 'output_text',
            text: finalText,
            annotations: [],
            logprobs: [],
          },
        ],
      },
    })}\n\n`,
  ];
}

/**
 * Emit tool call completion events
 */
function buildToolCallCompletionEvents(state: StreamState): string[] {
  const events: string[] = [];

  for (const tc of state.toolCalls.values()) {
    events.push(
      `event: response.function_call_arguments.done\ndata: ${JSON.stringify({
        type: 'response.function_call_arguments.done',
        sequence_number: state.sequenceNumber++,
        item_id: tc.itemId,
        output_index: tc.outputIndex,
        name: tc.name,
        arguments: tc.arguments,
      })}\n\n`,
      `event: response.output_item.done\ndata: ${JSON.stringify({
        type: 'response.output_item.done',
        sequence_number: state.sequenceNumber++,
        output_index: tc.outputIndex,
        item: {
          id: tc.itemId,
          type: 'function_call',
          call_id: tc.callId,
          name: tc.name,
          arguments: tc.arguments,
          status: 'completed',
        },
      })}\n\n`,
    );
  }

  return events;
}

/**
 * Transform a single Chat Completions stream chunk to Responses API stream events
 */
export function transformStreamChunk(chunk: string, state: StreamState): string | undefined {
  // Skip empty chunks and [DONE]
  const trimmed = chunk.trim();
  if (!trimmed || trimmed === 'data: [DONE]') {
    if (trimmed === 'data: [DONE]' && state.hasStarted && !state.completed) {
      state.completed = true;

      const completionEvents: string[] = [];

      if (state.hasEmittedTextOutputItem) {
        completionEvents.push(...buildTextCompletionEvents(state));
      }

      completionEvents.push(...buildToolCallCompletionEvents(state));

      completionEvents.push(
        `event: response.completed\ndata: ${JSON.stringify({
          type: 'response.completed',
          sequence_number: state.sequenceNumber++,
          response: buildResponseSnapshot(state, 'completed', true),
        })}\n\n`,
      );

      return completionEvents.join('');
    }
    return undefined;
  }

  // Parse the chunk
  const dataPrefix = 'data: ';
  if (!trimmed.startsWith(dataPrefix)) return undefined;

  let parsed: any;
  try {
    parsed = parseJson(trimmed.slice(dataPrefix.length));
  } catch (error) {
    captureException({
      error,
      extra: { chunk: trimmed.slice(0, 500) },
      message: 'failed to parse chat completions chunk in responses stream transform',
    });

    return undefined;
  }

  const events: string[] = [];

  // Initialize on first chunk
  if (!state.hasStarted) {
    state.hasStarted = true;
    state.responseId = `resp_${randomUUID()}`;
    state.outputItemId = `msg_${randomUUID()}`;
    state.contentPartIndex = 0;
    state.model = parsed.model || '';
    state.createdAt = Math.floor(Date.now() / 1000);

    events.push(
      `event: response.created\ndata: ${JSON.stringify({
        type: 'response.created',
        sequence_number: state.sequenceNumber++,
        response: buildResponseSnapshot(state, 'in_progress', false),
      })}\n\n`,
      `event: response.in_progress\ndata: ${JSON.stringify({
        type: 'response.in_progress',
        sequence_number: state.sequenceNumber++,
        response: buildResponseSnapshot(state, 'in_progress', false),
      })}\n\n`,
    );
  }

  // Handle content delta
  const delta = parsed.choices?.[0]?.delta;
  if (delta?.content) {
    if (!state.hasEmittedTextOutputItem) {
      state.hasEmittedTextOutputItem = true;
      events.push(
        `event: response.output_item.added\ndata: ${JSON.stringify({
          type: 'response.output_item.added',
          sequence_number: state.sequenceNumber++,
          output_index: 0,
          item: {
            id: state.outputItemId,
            type: 'message',
            role: 'assistant',
            status: 'in_progress',
            content: [],
          },
        })}\n\n`,
        `event: response.content_part.added\ndata: ${JSON.stringify({
          type: 'response.content_part.added',
          sequence_number: state.sequenceNumber++,
          item_id: state.outputItemId,
          output_index: 0,
          content_index: 0,
          part: { type: 'output_text', text: '', annotations: [], logprobs: [] },
        })}\n\n`,
      );
    }

    state.accumulatedText += delta.content;
    events.push(
      `event: response.output_text.delta\ndata: ${JSON.stringify({
        type: 'response.output_text.delta',
        sequence_number: state.sequenceNumber++,
        item_id: state.outputItemId,
        output_index: 0,
        content_index: 0,
        delta: delta.content,
        logprobs: [],
      })}\n\n`,
    );
  }

  // Handle thinking/reasoning from content_blocks (Anthropic, Gemini via gateway transform)
  if (delta?.content_blocks) {
    for (const block of delta.content_blocks) {
      const thinkingText = block.delta?.thinking ?? block.thinking;

      if (typeof thinkingText === 'string' && thinkingText) {
        if (!state.hasEmittedReasoningItem) {
          state.hasEmittedReasoningItem = true;
          state.reasoningItemId = `rs_${randomUUID()}`;

          events.push(
            `event: response.output_item.added\ndata: ${JSON.stringify({
              type: 'response.output_item.added',
              sequence_number: state.sequenceNumber++,
              output_index: 0,
              item: {
                id: state.reasoningItemId,
                type: 'reasoning',
                summary: [],
              },
            })}\n\n`,
            `event: response.reasoning_summary_part.added\ndata: ${JSON.stringify({
              type: 'response.reasoning_summary_part.added',
              sequence_number: state.sequenceNumber++,
              item_id: state.reasoningItemId,
              output_index: 0,
              summary_index: 0,
              part: { type: 'summary_text', text: '' },
            })}\n\n`,
          );
        }

        state.accumulatedReasoningText += thinkingText;

        events.push(
          `event: response.reasoning_summary_text.delta\ndata: ${JSON.stringify({
            type: 'response.reasoning_summary_text.delta',
            sequence_number: state.sequenceNumber++,
            item_id: state.reasoningItemId,
            output_index: 0,
            summary_index: 0,
            delta: thinkingText,
          })}\n\n`,
        );
      }
    }
  }

  // Handle tool calls
  if (delta?.tool_calls) {
    for (const tc of delta.tool_calls) {
      const index = tc.index ?? 0;

      if (tc.function?.name) {
        const itemId = `fc_${randomUUID()}`;
        const callId = tc.id || `call_${randomUUID()}`;

        state.toolCalls.set(index, {
          itemId,
          callId,
          name: tc.function.name,
          arguments: '',
          outputIndex: index,
        });

        events.push(
          `event: response.output_item.added\ndata: ${JSON.stringify({
            type: 'response.output_item.added',
            sequence_number: state.sequenceNumber++,
            output_index: index,
            item: {
              id: itemId,
              type: 'function_call',
              call_id: callId,
              name: tc.function.name,
              arguments: '',
              status: 'in_progress',
            },
          })}\n\n`,
        );
      }

      if (tc.function?.arguments) {
        const toolCall = state.toolCalls.get(index);
        if (toolCall) {
          toolCall.arguments += tc.function.arguments;

          events.push(
            `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({
              type: 'response.function_call_arguments.delta',
              sequence_number: state.sequenceNumber++,
              item_id: toolCall.itemId,
              output_index: index,
              delta: tc.function.arguments,
            })}\n\n`,
          );
        }
      }
    }
  }

  // Track usage if provided
  if (parsed.usage) {
    state.inputTokens = parsed.usage.prompt_tokens || 0;
    state.outputTokens = parsed.usage.completion_tokens || 0;
  }

  // Track finish reason
  if (parsed.choices?.[0]?.finish_reason) {
    state.finishReason = parsed.choices[0].finish_reason;
  }

  return events.length > 0 ? events.join('') : undefined;
}

/**
 * Create initial stream state
 */
export function createStreamState(): StreamState {
  return {
    responseId: '',
    outputItemId: '',
    reasoningItemId: null,
    accumulatedReasoningText: '',
    contentPartIndex: 0,
    hasStarted: false,
    hasEmittedReasoningItem: false,
    hasEmittedTextOutputItem: false,
    completed: false,
    model: '',
    inputTokens: 0,
    outputTokens: 0,
    finishReason: null,
    sequenceNumber: 0,
    accumulatedText: '',
    createdAt: 0,
    toolCalls: new Map(),
  };
}
