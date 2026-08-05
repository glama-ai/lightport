import { describe, expect, it } from 'vitest';
import ProviderConfigs from '../index';
import { transformUsingProviderConfig } from '../../services/transformToProviderRequest';
import type { ChatCompletionResponse, ProviderConfig } from '../types';
import type { Options, Params } from '../../types/requestBody';

const workersAi = (ProviderConfigs as any)['workers-ai'];
const providerOptions = { workersAiAccountId: 'acct123', apiKey: 'k' } as unknown as Options;
const model = '@cf/meta/llama-3.1-8b-instruct';

const address = (fn: string) =>
  workersAi.api.getBaseURL({ providerOptions }) +
  workersAi.api.getEndpoint({ fn, providerOptions, gatewayRequestBodyJSON: { model } });

const complete = (response: Record<string, unknown>, strictOpenAiCompliance = true, status = 200) =>
  workersAi.responseTransforms.chatComplete(
    response,
    status,
    new Headers(),
    strictOpenAiCompliance,
    '',
    { model } as Params,
  );

const streamChunk = (chunk: Record<string, unknown>) =>
  JSON.parse(
    workersAi.responseTransforms['stream-chatComplete'](
      `data: ${JSON.stringify(chunk)}`,
      'fallback',
      {},
      true,
      { model } as Params,
    ).replace(/^data: /, ''),
  );

describe('where a workers-ai request is addressed', () => {
  it('sends a chat completion to the route that answers in OpenAI’s shape', () => {
    // One address for every model, which is why the model moves into the body.
    expect(address('chatComplete')).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acct123/ai/v1/chat/completions',
    );
  });

  it('leaves the endpoints that name the model in the path where they were', () => {
    // The base stops earlier than it used to, so these have to add back the part
    // it no longer carries — getting that wrong would silently move three
    // endpoints that were working.
    for (const fn of ['complete', 'embed', 'imageGenerate']) {
      expect(address(fn)).toBe(
        `https://api.cloudflare.com/client/v4/accounts/acct123/ai/run/${model}`,
      );
    }
  });

  it('asks a custom host for the part the base no longer carries', () => {
    // A custom host replaces the base entire, so what the endpoint contributes is
    // the whole of what gets appended to it. `/run` moved into the endpoint, which
    // is the breaking half of this change: a host written to end where the base
    // used to end now has that segment arriving after it rather than within it.
    const endpoint = (fn: string) =>
      workersAi.api.getEndpoint({ fn, providerOptions, gatewayRequestBodyJSON: { model } });

    expect(endpoint('complete')).toBe(`/run/${model}`);
    expect(endpoint('chatComplete')).toBe('/v1/chat/completions');
  });
});

describe('what workers-ai is sent', () => {
  it('names the model in the body, where the new route reads it', () => {
    const request = transformUsingProviderConfig(
      workersAi.chatComplete as ProviderConfig,
      {
        model,
        messages: [{ role: 'user', content: 'hi' }],
      } as Params,
    );

    expect(request.model).toBe(model);
  });

  it('still turns a developer message into a system one', () => {
    const request = transformUsingProviderConfig(
      workersAi.chatComplete as ProviderConfig,
      {
        model,
        messages: [{ role: 'developer', content: 'be brief' }],
      } as Params,
    );

    expect(request.messages[0].role).toBe('system');
  });

  it('carries the parameters the route takes, tools among them', () => {
    const request = transformUsingProviderConfig(
      workersAi.chatComplete as ProviderConfig,
      {
        model,
        messages: [{ role: 'user', content: 'hi' }],
        max_completion_tokens: 256,
        temperature: 0.5,
        top_p: 0.9,
        tools: [{ type: 'function', function: { name: 'f' } }],
        tool_choice: 'auto',
      } as Params,
    );

    expect(request.max_tokens).toBe(256);
    expect(request.temperature).toBe(0.5);
    expect(request.top_p).toBe(0.9);
    expect(request.tools).toHaveLength(1);
    expect(request.tool_choice).toBe('auto');
  });

  it('carries the rest of what an OpenAI-shaped route is asked', () => {
    // Only what is named in the config is forwarded, so each of these is a
    // parameter a caller can send and watch disappear until it is listed.
    const request = transformUsingProviderConfig(
      workersAi.chatComplete as ProviderConfig,
      {
        model,
        messages: [{ role: 'user', content: 'hi' }],
        seed: 7,
        stop: ['\n\n'],
        n: 2,
        response_format: { type: 'json_object' },
        frequency_penalty: 0.1,
        presence_penalty: 0.2,
      } as Params,
    );

    expect(request.seed).toBe(7);
    expect(request.stop).toEqual(['\n\n']);
    expect(request.n).toBe(2);
    expect(request.response_format).toEqual({ type: 'json_object' });
    expect(request.frequency_penalty).toBe(0.1);
    expect(request.presence_penalty).toBe(0.2);
  });

  it('can be asked what a streamed turn cost', () => {
    const request = transformUsingProviderConfig(
      workersAi.chatComplete as ProviderConfig,
      {
        model,
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        stream_options: { include_usage: true },
      } as Params,
    );

    expect(request.stream_options).toEqual({ include_usage: true });
  });

  it('does not send a parameter belonging to the route it left', () => {
    // `raw` is a parameter of the model-in-path route and means nothing here.
    const request = transformUsingProviderConfig(
      workersAi.chatComplete as ProviderConfig,
      {
        model,
        messages: [{ role: 'user', content: 'hi' }],
        raw: true,
      } as Params,
    );

    expect(request).not.toHaveProperty('raw');
  });
});

describe('what workers-ai answers with', () => {
  const openAiShaped = {
    id: 'c1',
    object: 'chat.completion',
    created: 1_700_000_000,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: '',
          reasoning_content: 'all of it',
          tool_calls: [{ id: 't1', type: 'function', function: { name: 'f', arguments: '{}' } }],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 90, total_tokens: 100 },
  };

  it('keeps what the old route had no way to say', () => {
    // A single string cannot carry a tool call, a reason for stopping, or what
    // the turn cost. The new route reports all three, and they are carried whole.
    const result = complete(openAiShaped) as ChatCompletionResponse;

    expect(result.provider).toBe('workers-ai');
    expect(result.choices[0].message.tool_calls).toHaveLength(1);
    expect(result.choices[0].finish_reason).toBe('tool_calls');
    expect(result.usage?.total_tokens).toBe(100);
    expect((result.choices[0].message as any).reasoning_content).toBe('all of it');
  });

  it('reads thinking reported under the other name for it', () => {
    // The gpt-oss models Workers AI serves report it as `reasoning`.
    const result = complete({
      ...openAiShaped,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'answer', reasoning: 'the thinking' },
          finish_reason: 'stop',
        },
      ],
    }) as ChatCompletionResponse;

    expect((result.choices[0].message as any).reasoning_content).toBe('the thinking');
  });

  it('offers the thinking as a content block once compliance is relaxed', () => {
    const result = complete(openAiShaped, false) as ChatCompletionResponse;

    expect((result.choices[0].message as any).content_blocks).toContainEqual({
      type: 'thinking',
      thinking: 'all of it',
    });
  });

  it('still reads the shape the old route answered in', () => {
    // Kept so that whatever still replies that way is not left unreadable.
    const result = complete({
      result: { response: 'hello' },
      success: true,
      errors: [],
      messages: [],
    }) as ChatCompletionResponse;

    expect(result.choices[0].message.content).toBe('hello');
    expect(result.provider).toBe('workers-ai');
  });

  it('reads the usage and the tool call out of that shape too', () => {
    // That route names all three in its output schema. Reading the reply alone is
    // the loss this change exists to stop, and leaving it in the branch kept for
    // compatibility would be committing it in the one place nobody would look.
    const result = complete({
      result: {
        response: '',
        tool_calls: [{ name: 'get_weather', arguments: { city: 'London' } }],
        usage: { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 },
      },
      success: true,
      errors: [],
      messages: [],
    }) as ChatCompletionResponse;

    expect(result.usage?.total_tokens).toBe(33);
    expect(result.choices[0].message.tool_calls?.[0].function).toEqual({
      name: 'get_weather',
      arguments: '{"city":"London"}',
    });
    // Not read from the reply, which gives none — inferred from a turn that
    // stopped to ask for a tool.
    expect(result.choices[0].finish_reason).toBe('tool_calls');
  });

  it('does not fall over on an empty result', () => {
    const result = complete({ result: null, success: true, errors: [], messages: [] }) as any;

    expect(result.error.message).toContain('Invalid response received');
  });

  it('does not hand back a failure as an answer', () => {
    // A body carrying choices under a status that says the turn failed, naming
    // its reason somewhere neither error shape reaches. Answering with it is how
    // a caller comes to act on a failure.
    const result = complete(openAiShaped, true, 500) as any;

    expect(result.error).toBeDefined();
    expect(result.choices).toBeUndefined();
  });

  it('reports an answer in neither shape as one it cannot read', () => {
    const result = complete({ something: 'unexpected' }) as any;

    expect(result.error.message).toContain('Invalid response received');
  });

  it('reads a refusal in Cloudflare’s own envelope', () => {
    const result = complete(
      { result: null, success: false, errors: [{ code: 10000, message: 'Authentication error' }] },
      true,
      401,
    ) as any;

    expect(result.error.message).toContain('Authentication error');
    expect(result.error.message).not.toContain('Invalid response received');
  });

  it('reads a refusal in the shape the route itself answers in', () => {
    // The OpenAI shape names no `errors`, so without a branch for it the failure
    // reached the caller as an answer that could not be read.
    const result = complete(
      { error: { message: 'model not found', type: 'invalid_request_error', code: 'not_found' } },
      true,
      404,
    ) as any;

    expect(result.error.message).toContain('model not found');
    expect(result.error.type).toBe('invalid_request_error');
    expect(result.error.message).not.toContain('Invalid response received');
  });
});

describe('what workers-ai streams', () => {
  it('forwards a delta whole, so a tool call in one survives', () => {
    const chunk = streamChunk({
      id: 'c1',
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            reasoning_content: 'thinking',
            tool_calls: [{ index: 0, id: 't1', function: { name: 'f' } }],
          },
          finish_reason: null,
        },
      ],
    });

    expect(chunk.choices[0].delta.tool_calls).toHaveLength(1);
    expect(chunk.choices[0].delta.reasoning_content).toBe('thinking');
    expect(chunk.provider).toBe('workers-ai');
  });

  it('forwards the chunk that carries what the turn cost and why it stopped', () => {
    // Cloudflare reports both on a final chunk that names no choice at all.
    // Anything rebuilding a chunk around `choices[0].delta` drops it entirely.
    const chunk = streamChunk({
      id: 'c1',
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });

    expect(chunk.usage.total_tokens).toBe(15);
  });

  it('carries the reason the model stopped', () => {
    const chunk = streamChunk({
      id: 'c1',
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    });

    expect(chunk.choices[0].finish_reason).toBe('tool_calls');
  });

  it('still reads the chunk shape the old route streamed', () => {
    const chunk = streamChunk({ response: 'hello' });

    expect(chunk.choices[0].delta.content).toBe('hello');
    expect(chunk.provider).toBe('workers-ai');
  });

  it('ends the stream the way it was ended', () => {
    // Checked before the chunk is parsed, so the terminator is never read as a
    // reply the transform cannot understand.
    expect(
      workersAi.responseTransforms['stream-chatComplete']('data: [DONE]', 'fallback', {}, true, {
        model,
      } as Params),
    ).toBe('data: [DONE]\n\n');
  });
});
