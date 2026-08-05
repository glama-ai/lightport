import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../../logger';
import { findUnsupportedResponsesFields } from '../responses/requestTransform';
import { applyAdapterRequestTransform } from '../../handlers/adapterUtils';
import type { Params } from '../../types/requestBody';

afterEach(() => {
  vi.restoreAllMocks();
});

const refusedFor = (req: Record<string, any>) => findUnsupportedResponsesFields(req).refused;
const ignoredFor = (req: Record<string, any>) => findUnsupportedResponsesFields(req).ignored;

describe('what a translated Responses request cannot be given', () => {
  // The request is served by translating it into a chat completion, which keeps
  // nothing between turns and leaves nothing to fetch afterwards.
  it('refuses a conversation continued from a response that was never kept', () => {
    expect(refusedFor({ previous_response_id: 'resp_1' })).toEqual(['previous_response_id']);
  });

  it('refuses a conversation held on the provider’s side', () => {
    expect(refusedFor({ conversation: 'conv_1' })).toEqual(['conversation']);
  });

  it('refuses a stored prompt template that is never fetched', () => {
    expect(refusedFor({ prompt: { id: 'pmpt_1' } })).toEqual(['prompt']);
  });

  it('refuses content asked for that will not be in the answer', () => {
    // `reasoning.encrypted_content` is how a stateless caller carries reasoning
    // between turns, so losing it quietly breaks the one thing this route does.
    expect(refusedFor({ include: ['reasoning.encrypted_content'] })).toEqual(['include']);
  });

  it('refuses a tool the model is never offered', () => {
    expect(refusedFor({ tools: [{ type: 'web_search' }] })).toEqual(['tools']);
    // A function is the one kind that reaches the model.
    expect(refusedFor({ tools: [{ type: 'function', name: 'f' }] })).toEqual([]);
  });

  it('refuses a background request however the body spelled true', () => {
    // A form-encoded body arrives as strings, so a strict comparison would let
    // the request through the way it came.
    expect(refusedFor({ background: 'true' })).toEqual(['background']);
  });

  it('refuses a request asking to be run in the background', () => {
    expect(refusedFor({ background: true })).toEqual(['background']);
  });

  it('names every one of them, so the caller fixes the request once', () => {
    expect(
      refusedFor({ previous_response_id: 'resp_1', conversation: 'conv_1', background: true }),
    ).toEqual(['previous_response_id', 'conversation', 'background']);
  });
});

describe('what is already true without doing anything', () => {
  // Asking for none of a thing is satisfied by having none of it, so these are
  // neither refused nor worth a word.
  it('accepts a request naming store either way', () => {
    // It defaults to true upstream, so refusing it would turn on whether the
    // caller wrote the default down rather than on what they meant — and
    // fetching the response later is already refused in its own right.
    expect(findUnsupportedResponsesFields({ store: true })).toEqual({ refused: [], ignored: [] });
    expect(findUnsupportedResponsesFields({ store: false })).toEqual({ refused: [], ignored: [] });
  });

  it('accepts a request that asks not to be run in the background', () => {
    expect(findUnsupportedResponsesFields({ background: false })).toEqual({
      refused: [],
      ignored: [],
    });
  });

  it('accepts a request that asks for no truncation', () => {
    expect(findUnsupportedResponsesFields({ truncation: 'disabled' })).toEqual({
      refused: [],
      ignored: [],
    });
  });

  it('accepts an empty previous response id, which names no response', () => {
    expect(refusedFor({ previous_response_id: '' })).toEqual([]);
    expect(refusedFor({ previous_response_id: null })).toEqual([]);
  });

  it('accepts a request naming none of it at all', () => {
    expect(findUnsupportedResponsesFields({ model: 'm', input: 'hi' })).toEqual({
      refused: [],
      ignored: [],
    });
    expect(findUnsupportedResponsesFields(undefined)).toEqual({ refused: [], ignored: [] });
  });
});

describe('what is served but not acted on', () => {
  // These ask for the answer to be arrived at differently rather than for a
  // different answer, so the request still means what it said.
  it('notes a truncation strategy nothing carries out', () => {
    expect(ignoredFor({ truncation: 'auto' })).toEqual(['truncation']);
  });

  it('notes a service tier nothing routes by', () => {
    expect(ignoredFor({ service_tier: 'priority' })).toEqual(['service_tier']);
    // `auto` is what happens anyway, so it asks for nothing.
    expect(ignoredFor({ service_tier: 'auto' })).toEqual([]);
  });

  it('notes the caching and accounting hints nothing acts on', () => {
    expect(ignoredFor({ prompt_cache_key: 'k' })).toEqual(['prompt_cache_key']);
    expect(ignoredFor({ prompt_cache_retention: '24h' })).toEqual(['prompt_cache_retention']);
    expect(ignoredFor({ max_tool_calls: 3 })).toEqual(['max_tool_calls']);
    expect(ignoredFor({ safety_identifier: 'user-1' })).toEqual(['safety_identifier']);
  });

  it('says nothing about an empty include, which asks for nothing', () => {
    expect(findUnsupportedResponsesFields({ include: [] })).toEqual({ refused: [], ignored: [] });
  });

  it('keeps them apart from the ones that are refused', () => {
    const { refused, ignored } = findUnsupportedResponsesFields({
      previous_response_id: 'resp_1',
      truncation: 'auto',
    });

    expect(refused).toEqual(['previous_response_id']);
    expect(ignored).toEqual(['truncation']);
  });
});

describe('a Responses request reaching a provider through the translation', () => {
  const send = (provider: string, params: Record<string, any>) =>
    applyAdapterRequestTransform(
      'createModelResponse',
      provider,
      { model: 'm', input: 'hi', ...params } as Params,
      { model: 'm', input: 'hi', ...params } as Params,
      false,
      'POST',
    );

  it('is refused, and told which field and why', async () => {
    const result = send('anthropic', { previous_response_id: 'resp_1' });

    expect(result).toBeInstanceOf(Response);

    const response = result as Response;
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error.param).toBe('previous_response_id');
    expect(body.error.type).toBe('invalid_request_error');
    // The message names the provider, so the caller knows which one to change.
    expect(body.error.message).toContain('previous_response_id');
    expect(body.error.message).toContain('anthropic');
  });

  it('is served when it asks for nothing the translation cannot give', () => {
    const result = send('anthropic', { truncation: 'auto' });

    expect(result).not.toBeInstanceOf(Response);
    expect((result as any).fn).toBe('chatComplete');
  });

  it('is left alone for a provider that serves the Responses API itself', () => {
    // Nothing is translated there, so the field reaches the provider and it is
    // the provider's to answer for.
    for (const provider of ['openai', 'azure-openai', 'x-ai', 'groq', 'openrouter']) {
      expect(send(provider, { previous_response_id: 'resp_1' })).toBeNull();
    }
  });

  it('is refused when streamed too, the translation being no different', () => {
    const result = applyAdapterRequestTransform(
      'createModelResponse',
      'anthropic',
      { model: 'm', input: 'hi', previous_response_id: 'resp_1', stream: true } as Params,
      { model: 'm', input: 'hi', previous_response_id: 'resp_1', stream: true } as Params,
      true,
      'POST',
    );

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(400);
  });

  it('says in the log what it served without acting on', () => {
    // The warning is the whole of what a caller gets for these, so it is the
    // only thing standing between them and an assumption.
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as any);

    send('anthropic', { truncation: 'auto', prompt_cache_key: 'k' });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatchObject({
      ignored: ['truncation', 'prompt_cache_key'],
      provider: 'anthropic',
    });
  });

  it('says nothing when there was nothing to say', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as any);

    send('anthropic', {});

    expect(warn).not.toHaveBeenCalled();
  });
});
