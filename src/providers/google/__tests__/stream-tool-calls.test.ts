import { createStreamState, transformStreamChunk } from '../../../adapters/responses';
import { GoogleChatCompleteStreamChunkTransform as VertexStreamTransform } from '../../google-vertex-ai/chatComplete';
import { GoogleChatCompleteStreamChunkTransform as GoogleStreamTransform } from '../chatComplete';
import { describe, expect, it } from 'vitest';

type Part = Record<string, unknown>;

const call = (name: string, args: Record<string, unknown> = {}): Part => ({
  functionCall: { args, name },
});

const chunk = (parts: Part[], finishReason?: string, extra: Record<string, unknown> = {}) =>
  `data: ${JSON.stringify({
    candidates: [
      {
        content: { parts, role: 'model' },
        ...(finishReason && { finishReason }),
        index: 0,
        ...extra,
      },
    ],
    modelVersion: 'gemini-2.5-flash',
  })}`;

const read = (frame: string) => JSON.parse(frame.replace(/^data: /, '').trim());

describe.each([
  ['google', GoogleStreamTransform],
  ['vertex-ai', VertexStreamTransform],
])('%s streamed tool calls', (_provider, transform) => {
  const stream = (chunks: string[], strict = true) => {
    const state = {};

    return chunks.map((c) => read(transform(c, 'chatcmpl-test', state, strict)).choices[0]);
  };

  it('keeps a call that follows text in the same chunk', () => {
    const [choice] = stream([
      chunk([{ text: 'Let me check.' }, call('weather', { city: 'Paris' })]),
    ]);

    expect(choice.delta.content).toBe('Let me check.');
    expect(choice.delta.tool_calls).toEqual([
      expect.objectContaining({
        function: { arguments: '{"city":"Paris"}', name: 'weather' },
        index: 0,
        type: 'function',
      }),
    ]);
  });

  it('keeps a call that follows a thought in the same chunk', () => {
    const [choice] = stream(
      [chunk([{ text: 'Weather needs a tool.', thought: true }, call('weather')])],
      false,
    );

    expect(choice.delta.tool_calls).toHaveLength(1);
    expect(choice.delta.content_blocks).toEqual([
      { delta: { thinking: 'Weather needs a tool.' }, index: 0 },
    ]);
  });

  it('sends no empty entry for the text that follows a call', () => {
    const [choice] = stream([chunk([call('weather'), { text: 'Checking now.' }])]);

    expect(choice.delta.tool_calls).toHaveLength(1);
    expect(choice.delta.tool_calls).not.toContain(null);
    expect(choice.delta.content).toBe('Checking now.');
  });

  it('numbers calls by their place in the response, not in the chunk', () => {
    const choices = stream([chunk([call('weather')]), chunk([call('time')], 'STOP')]);

    expect(choices[0].delta.tool_calls.map((c: any) => c.index)).toEqual([0]);
    expect(choices[1].delta.tool_calls.map((c: any) => c.index)).toEqual([1]);
  });

  it('numbers calls that share a chunk one after another', () => {
    const [choice] = stream([chunk([call('weather'), call('time')])]);

    expect(choice.delta.tool_calls.map((c: any) => c.index)).toEqual([0, 1]);
  });

  it('finishes as tool_calls when a call arrived beside text', () => {
    const choices = stream([
      chunk([{ text: 'Let me check.' }, call('weather')]),
      chunk([{ text: '' }], 'STOP'),
    ]);

    expect(choices[1].finish_reason).toBe('tool_calls');
  });

  it('still streams text alone as it did', () => {
    const [strict] = stream([chunk([{ text: 'Hello' }])]);
    const [loose] = stream([chunk([{ text: 'Hello' }])], false);

    expect(strict.delta).toEqual({ content: 'Hello', role: 'assistant' });
    expect(loose.delta.content_blocks).toEqual([{ delta: { text: 'Hello' }, index: 0 }]);
  });

  it('still streams an image as a content block', () => {
    const [choice] = stream([chunk([{ inlineData: { data: 'AAAA', mimeType: 'image/png' } }])]);

    expect(choice.delta.content_blocks).toEqual([
      { delta: { image_url: { url: 'data:image/png;base64,AAAA' }, type: 'image_url' }, index: 0 },
    ]);
    expect(choice.delta).not.toHaveProperty('content');
  });

  it('says why when a candidate ends with nothing but a reason', () => {
    const [choice] = stream([
      chunk([], 'MALFORMED_FUNCTION_CALL', { finishMessage: 'Malformed function call: weather(' }),
    ]);

    expect(choice.delta.content).toBe('Malformed function call: weather(');
  });

  // The Responses adapter assembles calls by index, and could not read past the
  // `null` a call followed by text used to leave behind.
  it('reaches the Responses API as one call each', () => {
    const chatState = {};
    const responsesState = createStreamState();
    const events = [
      chunk([call('weather', { city: 'Paris' }), { text: 'Checking.' }]),
      chunk([call('time', { zone: 'CET' })], 'STOP'),
    ]
      .map((c) => transform(c, 'chatcmpl-test', chatState, true))
      .concat('data: [DONE]\n\n')
      .map((frame) => transformStreamChunk(frame, responsesState) ?? '')
      .join('');

    const completed = events
      .split('\n\n')
      .map((event) => event.split('\n').find((line) => line.startsWith('data: ')))
      .filter((line): line is string => Boolean(line))
      .map((line) => JSON.parse(line.slice('data: '.length)))
      .find((event) => event.type === 'response.completed');

    const calls = completed.response.output.filter((item: any) => item.type === 'function_call');

    expect(calls.map((item: any) => [item.name, item.arguments])).toEqual([
      ['weather', '{"city":"Paris"}'],
      ['time', '{"zone":"CET"}'],
    ]);
  });
});
