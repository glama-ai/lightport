import { describe, expect, it } from 'vitest';
import { transformResponsesToChatCompletions } from '../../../adapters/responses/requestTransform';
import { transformUsingProviderConfig } from '../../../services/transformToProviderRequest';
import type { Params } from '../../../types/requestBody';
import { VertexGoogleChatCompleteConfig } from '../../google-vertex-ai/chatComplete';
import { GoogleChatCompleteConfig } from '../chatComplete';

describe.each([
  ['google', GoogleChatCompleteConfig],
  ['vertex-ai', VertexGoogleChatCompleteConfig],
])('%s system instruction', (_provider, config) => {
  const sent = (messages: unknown[]) =>
    transformUsingProviderConfig(config, {
      messages,
      model: 'gemini-2.5-flash',
    } as unknown as Params) as Record<string, any>;

  it('keeps an instruction given after the first message', () => {
    const request = sent([
      { content: 'Be terse.', role: 'system' },
      { content: 'Hi', role: 'user' },
      { content: 'Answer in French.', role: 'developer' },
    ]);

    expect(request.systemInstruction.parts).toEqual([
      { text: 'Be terse.' },
      { text: 'Answer in French.' },
    ]);
    expect(request.contents.map((c: any) => c.role)).toEqual(['user']);
  });

  it('keeps every part of an instruction written as parts', () => {
    const request = sent([
      {
        content: [
          { text: 'Be terse.', type: 'text' },
          { text: 'Answer in French.', type: 'text' },
        ],
        role: 'system',
      },
      { content: 'Hi', role: 'user' },
    ]);

    expect(request.systemInstruction.parts).toEqual([
      { text: 'Be terse.' },
      { text: 'Answer in French.' },
    ]);
  });

  it('keeps an instruction when the conversation does not open with one', () => {
    const request = sent([
      { content: 'Hi', role: 'user' },
      { content: 'Be terse.', role: 'system' },
    ]);

    expect(request.systemInstruction.parts).toEqual([{ text: 'Be terse.' }]);
  });

  it('sends no instruction where none was given', () => {
    expect(sent([{ content: 'Hi', role: 'user' }]).systemInstruction).toBeFalsy();
    expect(
      sent([
        { content: '', role: 'system' },
        { content: 'Hi', role: 'user' },
      ]).systemInstruction,
    ).toBeFalsy();
  });

  it('keeps what a turn said before the calls it made', () => {
    const request = sent([
      { content: 'Weather in Paris?', role: 'user' },
      {
        content: 'Let me check.',
        role: 'assistant',
        tool_calls: [
          {
            function: { arguments: '{"city":"Paris"}', name: 'weather' },
            id: 'c1',
            type: 'function',
          },
        ],
      },
      { content: 'sunny', name: 'weather', role: 'tool', tool_call_id: 'c1' },
    ]);

    expect(request.contents[1].parts).toEqual([
      { text: 'Let me check.' },
      expect.objectContaining({ functionCall: { args: { city: 'Paris' }, name: 'weather' } }),
    ]);
  });

  it('sends a turn that only called as calls alone, as before', () => {
    const request = sent([
      { content: 'Weather in Paris?', role: 'user' },
      {
        content: '',
        role: 'assistant',
        tool_calls: [
          { function: { arguments: '{}', name: 'weather' }, id: 'c1', type: 'function' },
        ],
      },
    ]);

    expect(request.contents[1].parts).toEqual([
      expect.objectContaining({ functionCall: { args: {}, name: 'weather' } }),
    ]);
  });

  // Codex sends `instructions` and developer items together.
  it('keeps both instructions of a responses request', () => {
    const chat = transformResponsesToChatCompletions({
      input: [
        { content: 'Prefer short answers.', role: 'developer' },
        { content: 'Hi', role: 'user' },
      ],
      instructions: 'You are a coding agent.',
      model: 'gemini-2.5-flash',
    } as any);

    expect(sent(chat.messages as unknown[]).systemInstruction.parts).toEqual([
      { text: 'You are a coding agent.' },
      { text: 'Prefer short answers.' },
    ]);
  });
});
