import { describe, expect, it } from 'vitest';
import { createStreamState, transformStreamChunk } from '../../adapters/responses';
import {
  getAnthropicChatCompleteResponseTransform,
  getAnthropicStreamChunkTransform,
} from '../anthropic/chatComplete';
import {
  BedrockChatCompleteResponseTransform,
  BedrockChatCompleteStreamChunkTransform,
} from '../bedrock/chatComplete';

const THINKING = 'Two plus two is four.';

const anthropicReply = {
  content: [
    { signature: 'sig', thinking: THINKING, type: 'thinking' },
    { text: '4', type: 'text' },
  ],
  id: 'msg_1',
  model: 'claude-sonnet-4-5',
  role: 'assistant',
  stop_reason: 'end_turn',
  stop_sequence: null,
  type: 'message',
  usage: { input_tokens: 3, output_tokens: 9 },
};

const bedrockReply = {
  metrics: { latencyMs: 1 },
  output: {
    message: {
      content: [
        { reasoningContent: { reasoningText: { signature: 'sig', text: THINKING } } },
        { text: '4' },
      ],
      role: 'assistant',
    },
  },
  stopReason: 'end_turn',
  usage: { inputTokens: 3, outputTokens: 9, totalTokens: 12 },
};

const deltaOf = (frame: string | string[] | undefined) =>
  JSON.parse(
    String(frame)
      .split('\n\n')[0]
      .replace(/^data: /, ''),
  ).choices[0].delta;

describe.each(['anthropic', 'vertex-ai', 'azure-ai'])("%s claude's thinking", (provider) => {
  const complete = getAnthropicChatCompleteResponseTransform(provider);
  const stream = getAnthropicStreamChunkTransform(provider);

  // Strict compliance is the default, and the thinking was only ever in the
  // `content_blocks` it leaves out.
  it('reaches a strict caller as reasoning_content', () => {
    const message = (complete(anthropicReply as any, 200, new Headers(), true) as any).choices[0]
      .message;

    expect(message.reasoning_content).toBe(THINKING);
    expect(message.content).toBe('4');
    expect(message).not.toHaveProperty('content_blocks');
  });

  it('still reaches a loose caller as content blocks too', () => {
    const message = (complete(anthropicReply as any, 200, new Headers(), false) as any).choices[0]
      .message;

    expect(message.reasoning_content).toBe(THINKING);
    expect(message.content_blocks).toContainEqual(expect.objectContaining({ thinking: THINKING }));
  });

  it('streams to a strict caller as reasoning_content', () => {
    const chunk = `data: ${JSON.stringify({
      delta: { thinking: 'Two plus', type: 'thinking_delta' },
      index: 0,
      type: 'content_block_delta',
    })}`;

    expect(deltaOf(stream(chunk, 'fallback', {} as any, true)).reasoning_content).toBe('Two plus');
  });

  it('says nothing of reasoning when there was none', () => {
    const message = (
      complete(
        { ...anthropicReply, content: [{ text: '4', type: 'text' }] } as any,
        200,
        new Headers(),
        true,
      ) as any
    ).choices[0].message;

    expect(message).not.toHaveProperty('reasoning_content');
  });
});

describe("bedrock's reasoning", () => {
  it('reaches a strict caller as reasoning_content', () => {
    const message = (
      BedrockChatCompleteResponseTransform(bedrockReply as any, 200, new Headers(), true, '', {
        model: 'anthropic.claude-sonnet-4-5',
      } as any) as any
    ).choices[0].message;

    expect(message.reasoning_content).toBe(THINKING);
    expect(message).not.toHaveProperty('content_blocks');
  });

  it('streams to a strict caller as reasoning_content', () => {
    const delta = deltaOf(
      BedrockChatCompleteStreamChunkTransform(
        JSON.stringify({ contentBlockIndex: 0, delta: { reasoningContent: { text: 'Two plus' } } }),
        'fallback',
        {} as any,
        true,
        { model: 'anthropic.claude-sonnet-4-5' } as any,
      ),
    );

    expect(delta.reasoning_content).toBe('Two plus');
  });
});

// The adapters run with strict compliance off, so they are handed the thinking
// twice over, and must count it once.
describe('reasoning sent both ways through the responses adapter', () => {
  it('is reported once', () => {
    const stream = getAnthropicStreamChunkTransform('anthropic');
    const chatState = {} as any;
    const responsesState = createStreamState();
    const events = [
      `data: ${JSON.stringify({
        message: { model: 'claude-sonnet-4-5', usage: { input_tokens: 3 } },
        type: 'message_start',
      })}`,
      `data: ${JSON.stringify({
        content_block: { thinking: '', type: 'thinking' },
        index: 0,
        type: 'content_block_start',
      })}`,
      `data: ${JSON.stringify({
        delta: { thinking: THINKING, type: 'thinking_delta' },
        index: 0,
        type: 'content_block_delta',
      })}`,
    ]
      .map((chunk) => stream(chunk, 'fallback', chatState, false) ?? '')
      .map((frame) => transformStreamChunk(frame, responsesState) ?? '')
      .join('');

    expect(events.split(THINKING).length - 1).toBe(1);
  });
});
