// Tool message content (OpenAI format) → Vertex Gemini functionResponse
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../data-stores/redis', () => ({
  redisClient: null,
  redisReaderClient: null,
}));

vi.mock('../../../utils/awsAuth', () => ({}));

vi.mock('../../..', () => ({}));

import { transformUsingProviderConfig } from '../../../services/transformToProviderRequest';
import { Params } from '../../../types/requestBody';
import { VertexGoogleChatCompleteConfig } from '../chatComplete';

describe('Google Vertex AI tool message content (OpenAI format)', () => {
  it('should transform tool message with string content to one functionResponse part', () => {
    const params = {
      model: 'gemini-2.5-flash',
      messages: [
        { role: 'user', content: 'Hello' },
        {
          role: 'assistant',
          tool_calls: [
            {
              id: '1',
              type: 'function',
              function: { name: 'get_time', arguments: '{}' },
            },
          ],
        },
        { role: 'tool', name: 'get_time', content: 'The time is 10PM' },
      ],
      tools: [{ type: 'function', function: { name: 'get_time', parameters: {} } }],
    } as Params;

    const transformed = transformUsingProviderConfig(VertexGoogleChatCompleteConfig, params);
    const toolContent = transformed.contents.find(
      (c: any) => c.role === 'user' && c.parts?.some((p: any) => p.functionResponse),
    );

    expect(toolContent).toBeDefined();
    expect(toolContent.parts).toHaveLength(1);
    expect(toolContent.parts[0].functionResponse).toEqual({
      name: 'get_time',
      response: { content: 'The time is 10PM' },
    });
  });

  it('should transform tool message with array of text parts to one functionResponse per text part', () => {
    const params = {
      model: 'gemini-2.5-flash',
      messages: [
        { role: 'user', content: 'Hello' },
        {
          role: 'assistant',
          tool_calls: [
            {
              id: '1',
              type: 'function',
              function: { name: 'get_time', arguments: '{}' },
            },
          ],
        },
        {
          role: 'tool',
          name: 'get_time',
          content: [
            { type: 'text', text: 'Part one' },
            { type: 'text', text: 'Part two' },
          ],
        },
      ],
      tools: [{ type: 'function', function: { name: 'get_time', parameters: {} } }],
    } as Params;

    const transformed = transformUsingProviderConfig(VertexGoogleChatCompleteConfig, params);
    const toolContent = transformed.contents.find(
      (c: any) => c.role === 'user' && c.parts?.some((p: any) => p.functionResponse),
    );

    expect(toolContent).toBeDefined();
    expect(toolContent.parts).toHaveLength(2);
    expect(toolContent.parts[0].functionResponse).toEqual({
      name: 'get_time',
      response: { content: 'Part one' },
    });
    expect(toolContent.parts[1].functionResponse).toEqual({
      name: 'get_time',
      response: { content: 'Part two' },
    });
  });

  it('should only include text parts when tool message content is array (OpenAI: text only)', () => {
    const params = {
      model: 'gemini-2.5-flash',
      messages: [
        { role: 'user', content: 'Hi' },
        {
          role: 'assistant',
          tool_calls: [
            {
              id: '1',
              type: 'function',
              function: { name: 'fn', arguments: '{}' },
            },
          ],
        },
        {
          role: 'tool',
          name: 'fn',
          content: [
            { type: 'text', text: 'Only this text' },
            {
              type: 'image_url',
              image_url: { url: 'https://example.com/img.png' },
            },
          ],
        },
      ],
      tools: [{ type: 'function', function: { name: 'fn', parameters: {} } }],
    } as Params;

    const transformed = transformUsingProviderConfig(VertexGoogleChatCompleteConfig, params);
    const toolContent = transformed.contents.find(
      (c: any) => c.role === 'user' && c.parts?.some((p: any) => p.functionResponse),
    );

    expect(toolContent).toBeDefined();
    const functionResponseParts = toolContent.parts.filter((p: any) => p.functionResponse);
    expect(functionResponseParts.length).toBeGreaterThanOrEqual(1);
    expect(functionResponseParts[0].functionResponse.response.content).toBe('Only this text');
  });
});

// Gemini rejects a content role outside its documented set with
// "Role 'function' is not supported", which fails the turn right after any tool
// call completes.
describe('Google Vertex AI two-turn tool flow content roles', () => {
  const ACCEPTED_ROLES = ['user', 'model'];

  it('should send the assistant tool call as model and the tool result as an accepted role', () => {
    const params = {
      model: 'gemini-2.5-flash',
      messages: [
        { role: 'user', content: 'What is the weather in San Francisco?' },
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_example',
              type: 'function',
              function: {
                name: 'get_weather',
                arguments: '{"location":"San Francisco"}',
              },
            },
          ],
        },
        {
          role: 'tool',
          name: 'get_weather',
          tool_call_id: 'call_example',
          content: '72F and sunny',
        },
      ],
      tools: [{ type: 'function', function: { name: 'get_weather', parameters: {} } }],
    } as Params;

    const transformed = transformUsingProviderConfig(VertexGoogleChatCompleteConfig, params);

    expect(transformed.contents).toHaveLength(3);
    expect(transformed.contents[0].role).toBe('user');

    expect(transformed.contents[1].role).toBe('model');
    expect(transformed.contents[1].parts[0].functionCall).toEqual({
      name: 'get_weather',
      args: { location: 'San Francisco' },
    });

    expect(transformed.contents[2].parts[0].functionResponse).toEqual({
      name: 'get_weather',
      response: { content: '72F and sunny' },
    });

    for (const content of transformed.contents) {
      expect(ACCEPTED_ROLES).toContain(content.role);
    }
  });

  it('should merge parallel tool results into a single accepted-role content', () => {
    const params = {
      model: 'gemini-2.5-flash',
      messages: [
        { role: 'user', content: 'Weather in both cities?' },
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"location":"SF"}' },
            },
            {
              id: 'call_2',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"location":"NYC"}' },
            },
          ],
        },
        { role: 'tool', name: 'get_weather', tool_call_id: 'call_1', content: '72F' },
        { role: 'tool', name: 'get_weather', tool_call_id: 'call_2', content: '58F' },
      ],
      tools: [{ type: 'function', function: { name: 'get_weather', parameters: {} } }],
    } as Params;

    const transformed = transformUsingProviderConfig(VertexGoogleChatCompleteConfig, params);

    expect(transformed.contents).toHaveLength(3);
    expect(transformed.contents[1].parts).toHaveLength(2);
    expect(transformed.contents[2].parts).toHaveLength(2);
    expect(
      transformed.contents[2].parts.map((p: any) => p.functionResponse.response.content),
    ).toEqual(['72F', '58F']);

    for (const content of transformed.contents) {
      expect(ACCEPTED_ROLES).toContain(content.role);
    }
  });

  it('should keep the turns alternating when a user message follows a tool result', () => {
    const params = {
      model: 'gemini-2.5-flash',
      messages: [
        { role: 'user', content: 'Weather?' },
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'get_weather', arguments: '{}' },
            },
          ],
        },
        { role: 'tool', name: 'get_weather', tool_call_id: 'call_1', content: '72F' },
        { role: 'user', content: 'And tomorrow?' },
      ],
      tools: [{ type: 'function', function: { name: 'get_weather', parameters: {} } }],
    } as Params;

    const transformed = transformUsingProviderConfig(VertexGoogleChatCompleteConfig, params);

    // Gemini answers a content holding a functionResponse part followed by a
    // text part with an empty candidate, so the follow-up question stays in a
    // content of its own rather than being combined into the tool result.
    expect(transformed.contents.map((c: any) => c.role)).toEqual(['user', 'model', 'user', 'user']);
    expect(transformed.contents[2].parts).toHaveLength(1);
    expect(transformed.contents[2].parts[0].functionResponse).toBeDefined();
    expect(transformed.contents[3].parts).toHaveLength(1);
    expect(transformed.contents[3].parts[0].text).toBe('And tomorrow?');
  });

  it('should transform the deprecated function role into a functionResponse turn', () => {
    const params = {
      model: 'gemini-2.5-flash',
      messages: [
        { role: 'user', content: 'Weather?' },
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'get_weather', arguments: '{}' },
            },
          ],
        },
        { role: 'function', name: 'get_weather', content: '72F' },
      ],
      tools: [{ type: 'function', function: { name: 'get_weather', parameters: {} } }],
    } as Params;

    const transformed = transformUsingProviderConfig(VertexGoogleChatCompleteConfig, params);

    expect(transformed.contents).toHaveLength(3);
    expect(transformed.contents[2].parts[0].functionResponse).toEqual({
      name: 'get_weather',
      response: { content: '72F' },
    });

    for (const content of transformed.contents) {
      expect(ACCEPTED_ROLES).toContain(content.role);
    }
  });
});
