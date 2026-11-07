import { describe, expect, it } from 'vitest';
import {
  GoogleChatCompleteResponseTransform as VertexResponseTransform,
  GoogleChatCompleteStreamChunkTransform as VertexStreamTransform,
} from '../../google-vertex-ai/chatComplete';
import {
  GoogleChatCompleteResponseTransform,
  GoogleChatCompleteStreamChunkTransform,
} from '../chatComplete';

// A reply spent wholly on thinking: Gemini leaves `candidatesTokenCount` out
// when it is zero, which is exactly when a thinking model runs out of tokens.
const thoughtOnly = {
  promptTokenCount: 12,
  thoughtsTokenCount: 64,
  totalTokenCount: 76,
};

const reply = (finishReason: string) => ({
  candidates: [{ content: { parts: [{ text: '' }], role: 'model' }, finishReason, index: 0 }],
  modelVersion: 'gemini-2.5-flash',
  usageMetadata: thoughtOnly,
});

describe.each([
  ['google', GoogleChatCompleteResponseTransform, GoogleChatCompleteStreamChunkTransform],
  ['vertex-ai', VertexResponseTransform, VertexStreamTransform],
] as const)('%s usage', (_provider, complete, stream) => {
  it('counts a reply spent wholly on thinking, rather than reporting null', () => {
    const result = (complete as any)(reply('MAX_TOKENS'), 200, new Headers(), true, '', {});

    expect(result.usage).toMatchObject({
      completion_tokens: 64,
      prompt_tokens: 12,
      prompt_tokens_details: { cached_tokens: 0 },
      total_tokens: 76,
    });
  });

  it('reports usage on the last chunk of such a reply', () => {
    const frame = (stream as any)(
      `data: ${JSON.stringify(reply('MAX_TOKENS'))}`,
      'fallback',
      {},
      true,
    );

    expect(JSON.parse(frame.replace(/^data: /, '')).usage).toMatchObject({
      completion_tokens: 64,
      total_tokens: 76,
    });
  });

  it('reports no usage on a chunk before the end that has said nothing yet', () => {
    const frame = (stream as any)(
      `data: ${JSON.stringify({ ...reply('STOP'), candidates: [{ content: { parts: [{ text: '' }] }, index: 0 }] })}`,
      'fallback',
      {},
      true,
    );

    expect(JSON.parse(frame.replace(/^data: /, ''))).not.toHaveProperty('usage');
  });
});
