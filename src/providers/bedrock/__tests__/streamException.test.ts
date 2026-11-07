import { describe, expect, it } from 'vitest';
import { readOpenAiErrorEvent } from '../../../errors/openAiError';
import { handleStreamingMode } from '../../../handlers/streamHandler';
import { BedrockChatCompleteStreamChunkTransform } from '../chatComplete';

const encoder = new TextEncoder();

const u32 = (value: number) => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
};

const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

/**
 * One message of the AWS event-stream encoding, with string headers. The CRCs
 * are left zero: the reader takes lengths from the prelude and checks neither.
 */
const frame = (headers: Record<string, string>, payload: string) => {
  const headerBytes = concat(
    Object.entries(headers).map(([name, value]) => {
      const nameBytes = encoder.encode(name);
      const valueBytes = encoder.encode(value);
      return concat([
        new Uint8Array([nameBytes.length]),
        nameBytes,
        // 7 is a string, whose two-byte length comes before it.
        new Uint8Array([7, valueBytes.length >> 8, valueBytes.length & 0xff]),
        valueBytes,
      ]);
    }),
  );
  const payloadBytes = encoder.encode(payload);
  const total = 12 + headerBytes.length + payloadBytes.length + 4;

  return concat([u32(total), u32(headerBytes.length), u32(0), headerBytes, payloadBytes, u32(0)]);
};

const event = (type: string, payload: Record<string, unknown>) =>
  frame(
    { ':content-type': 'application/json', ':event-type': type, ':message-type': 'event' },
    JSON.stringify(payload),
  );

const exception = (type: string, message: string) =>
  frame(
    { ':content-type': 'application/json', ':exception-type': type, ':message-type': 'exception' },
    JSON.stringify({ message }),
  );

const streamed = async (frames: Uint8Array[]) => {
  const upstream = new Response(
    new ReadableStream({
      start(controller) {
        for (const f of frames) controller.enqueue(f);
        controller.close();
      },
    }),
    { headers: { 'content-type': 'application/vnd.amazon.eventstream' } },
  );

  const response = handleStreamingMode(
    {} as any,
    upstream,
    'bedrock',
    BedrockChatCompleteStreamChunkTransform,
    'https://bedrock-runtime.us-east-1.amazonaws.com/model/m/converse-stream',
    true,
    { model: 'anthropic.claude-sonnet-4-5', stream: true } as any,
    'chatComplete',
    null,
  );

  return (await response.text()).split('\n\n').filter(Boolean);
};

describe('a bedrock exception mid-stream', () => {
  it('reaches the caller as the failure it is, named as bedrock named it', async () => {
    const frames = await streamed([
      event('messageStart', { role: 'assistant' }),
      event('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'Hel' } }),
      exception('throttlingException', 'Too many requests, please wait before trying again.'),
    ]);

    const error = frames.map(readOpenAiErrorEvent).find(Boolean);

    expect(error).toMatchObject({
      code: 'throttlingException',
      message: 'bedrock error: Too many requests, please wait before trying again.',
      type: 'throttlingException',
    });
  });

  // It used to end as though the reply had simply finished there.
  it('is not reported as a finished reply', async () => {
    const frames = await streamed([
      event('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'Hel' } }),
      exception('modelStreamErrorException', 'The model failed.'),
    ]);

    expect(frames.join('\n\n')).not.toContain('"finish_reason":"stop"');
    expect(frames).not.toContain('data: [DONE]');
  });

  it('still streams a reply that does finish', async () => {
    const frames = await streamed([
      event('messageStart', { role: 'assistant' }),
      event('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'Hello' } }),
      event('messageStop', { stopReason: 'end_turn' }),
      event('metadata', { usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } }),
    ]);

    expect(frames.map(readOpenAiErrorEvent).filter(Boolean)).toEqual([]);
    expect(frames.join('\n\n')).toContain('Hello');
  });
});
