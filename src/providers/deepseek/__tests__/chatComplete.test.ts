import {
  DeepSeekChatCompleteResponseTransform,
  DeepSeekChatCompleteStreamChunkTransform,
} from '../chatComplete';
import type { ChatCompletionResponse, ErrorResponse } from '../../types';
import { describe, expect, it } from 'vitest';

const transform = (response: unknown, status: number) =>
  DeepSeekChatCompleteResponseTransform(
    response as never,
    status,
    new Headers(),
    false,
  ) as ErrorResponse;

describe('DeepSeekChatCompleteResponseTransform', () => {
  it('surfaces the error DeepSeek actually sends, which is nested', () => {
    // The shape returned for a bad key. It used to fall through to the
    // invalid-response branch, so the caller was told the response could not be
    // understood while the reason sat unread inside it.
    const result = transform(
      {
        error: {
          message: 'Authentication Fails, Your api key: ****ey-1 is invalid',
          type: 'authentication_error',
          param: null,
          code: 'invalid_request_error',
        },
      },
      401,
    );

    expect(result.error.message).toContain('Authentication Fails');
    expect(result.error.message).not.toContain('Invalid response received');
    expect(result.error.type).toBe('authentication_error');
    expect(result.error.code).toBe('invalid_request_error');
    expect(result.provider).toBe('deepseek');
  });

  it('still surfaces the flat error shape', () => {
    const result = transform(
      { message: 'rate limited', type: 'rate_limit_error', param: null, code: '429' },
      429,
    );

    expect(result.error.message).toContain('rate limited');
    expect(result.error.type).toBe('rate_limit_error');
  });

  it('leaves a successful completion alone', () => {
    const result = DeepSeekChatCompleteResponseTransform(
      {
        id: 'chat-1',
        object: 'chat.completion',
        created: 1_700_000_000,
        model: 'deepseek-chat',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'pong' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      } as never,
      200,
      new Headers(),
      false,
    );

    expect(result).toMatchObject({
      provider: 'deepseek',
      choices: [{ message: { content: 'pong' } }],
    });
  });

  describe('reasoning', () => {
    const reasonerResponse = (message: Record<string, unknown>) => ({
      id: 'chat-2',
      object: 'chat.completion',
      created: 1_700_000_000,
      model: 'deepseek-reasoner',
      choices: [{ index: 0, message, finish_reason: 'stop', logprobs: null }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 90,
        total_tokens: 100,
        prompt_cache_hit_tokens: 6,
        prompt_cache_miss_tokens: 4,
        completion_tokens_details: { reasoning_tokens: 80 },
      },
    });

    const complete = (message: Record<string, unknown>, strict = true) =>
      DeepSeekChatCompleteResponseTransform(
        reasonerResponse(message) as never,
        200,
        new Headers(),
        strict,
      ) as ChatCompletionResponse;

    it('keeps the chain of thought the reasoner replied with', () => {
      // Rebuilding the message dropped this, so the caller saw only `content`.
      const result = complete({
        role: 'assistant',
        content: 'four',
        reasoning_content: 'two plus two',
      });

      expect((result.choices[0].message as any).reasoning_content).toBe('two plus two');
    });

    it('keeps it under the default, which is strict compliance', () => {
      // The stream forwards the delta whole and gates nothing, so gating the
      // non-streaming half would leave the two paths disagreeing by default.
      const answer = { role: 'assistant', content: '', reasoning_content: 'all of it' };

      const fromResponse = complete(answer, true).choices[0].message as any;
      const fromStream = JSON.parse(
        (
          DeepSeekChatCompleteStreamChunkTransform(
            `data: ${JSON.stringify({
              id: 'chat-2',
              object: 'chat.completion.chunk',
              created: 1_700_000_000,
              model: 'deepseek-reasoner',
              choices: [{ index: 0, delta: answer, finish_reason: null }],
            })}`,
            'fallback',
            {},
            true,
          ) as string
        ).replace(/^data: /, ''),
      );

      expect(fromResponse.reasoning_content).toBe('all of it');
      expect(fromStream.choices[0].delta.reasoning_content).toBe('all of it');
    });

    it('offers the thinking as a content block once compliance is relaxed', () => {
      // What the Messages and Responses adapters read to rebuild a reasoning block.
      const result = complete(
        { role: 'assistant', content: 'four', reasoning_content: 'two plus two' },
        false,
      );

      expect((result.choices[0].message as any).content_blocks).toEqual([
        { type: 'thinking', thinking: 'two plus two' },
        { type: 'text', text: 'four' },
      ]);
    });

    it('leaves the message alone when the model did not reason', () => {
      const message = complete({ role: 'assistant', content: 'pong' }).choices[0].message as any;

      expect(message).not.toHaveProperty('reasoning_content');
      expect(message).not.toHaveProperty('content_blocks');
    });

    it('reports the reasoning tokens that were billed', () => {
      // Read straight out of here by the Responses adapter.
      const result = complete({ role: 'assistant', content: 'four' });

      expect(result.usage?.completion_tokens_details?.reasoning_tokens).toBe(80);
      expect(result.usage?.prompt_tokens_details?.cached_tokens).toBe(6);
    });

    it('keeps the logprobs it was asked for', () => {
      const logprobs = { content: [{ token: 'four', logprob: -0.1, bytes: [] }] };
      const result = complete({ role: 'assistant', content: 'four' });

      expect(result.choices[0].logprobs).toBeNull();
      expect(
        (
          DeepSeekChatCompleteResponseTransform(
            {
              ...reasonerResponse({ role: 'assistant', content: 'four' }),
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: 'four' },
                  finish_reason: 'stop',
                  logprobs,
                },
              ],
            } as never,
            200,
            new Headers(),
            true,
          ) as ChatCompletionResponse
        ).choices[0].logprobs,
      ).toEqual(logprobs);
    });
  });

  it('reports a response it genuinely cannot read', () => {
    const result = transform({ something: 'unexpected' }, 200);

    expect(result.error.message).toContain('Invalid response received');
  });

  it('does not treat a 200 carrying an error key as a failure', () => {
    // The status check comes first, so a 200 is never routed to the error path.
    const result = transform({ error: { message: 'ignored' } }, 200);

    expect(result.error.message).toContain('Invalid response received');
  });
});
