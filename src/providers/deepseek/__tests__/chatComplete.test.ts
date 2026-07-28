import { DeepSeekChatCompleteResponseTransform } from '../chatComplete';
import type { ErrorResponse } from '../../types';
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
