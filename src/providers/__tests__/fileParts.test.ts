import { describe, expect, it } from 'vitest';
import { findUnsupportedResponsesFields } from '../../adapters/responses/requestTransform';
import { transformResponsesToChatCompletions } from '../../adapters/responses/requestTransform';
import { GatewayError } from '../../errors/GatewayError';
import { transformUsingProviderConfig } from '../../services/transformToProviderRequest';
import type { Params } from '../../types/requestBody';
import { AnthropicChatCompleteConfig } from '../anthropic/chatComplete';
import { BedrockConverseChatCompleteConfig } from '../bedrock/chatComplete';
import { VertexGoogleChatCompleteConfig } from '../google-vertex-ai/chatComplete';
import { GoogleChatCompleteConfig } from '../google/chatComplete';
import type { ProviderConfig } from '../types';
import { readFilePart } from '../utils/filePart';

const PDF = 'JVBERi0xLjQK';
const PDF_DATA_URL = `data:application/pdf;base64,${PDF}`;
const TEXT_DATA_URL = `data:text/plain;base64,${Buffer.from('Hello there').toString('base64')}`;

const asking = (part: Record<string, unknown>, model = 'a-model') =>
  ({
    model,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'What is this?' }, part] }],
  }) as unknown as Params;

const fileOf = (file: Record<string, unknown>) => ({ type: 'file', file });

const sent = (config: ProviderConfig, params: Params) =>
  transformUsingProviderConfig(config, params) as Record<string, any>;

const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
};

describe('readFilePart', () => {
  it('reads a data URL as OpenAI writes it', () => {
    expect(readFilePart({ file_data: PDF_DATA_URL, filename: 'a.pdf' })).toEqual({
      data: PDF,
      fromDataUrl: true,
      mimeType: 'application/pdf',
      name: 'a.pdf',
    });
  });

  it('reads raw content beside a mime type as it was first taken', () => {
    expect(readFilePart({ file_data: PDF, file_name: 'a', mime_type: 'application/pdf' })).toEqual({
      data: PDF,
      fromDataUrl: false,
      mimeType: 'application/pdf',
      name: 'a',
    });
  });

  it('takes the type from the name when nothing else gives it', () => {
    expect(readFilePart({ file_data: 'eA==', filename: 'notes.docx' })?.mimeType).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
  });

  it('cannot read a file named by id alone', () => {
    expect(readFilePart({ file_id: 'file-abc' })).toBeUndefined();
  });
});

describe('anthropic file parts', () => {
  it('sends a data URL as the base64 and type inside it', () => {
    const request = sent(
      AnthropicChatCompleteConfig,
      asking(fileOf({ file_data: PDF_DATA_URL, filename: 'a.pdf' })),
    );

    expect(request.messages[0].content[1]).toEqual({
      type: 'document',
      source: { type: 'base64', data: PDF, media_type: 'application/pdf' },
    });
  });

  it('sends plain text as the text it is', () => {
    const request = sent(AnthropicChatCompleteConfig, asking(fileOf({ file_data: TEXT_DATA_URL })));

    expect(request.messages[0].content[1].source).toEqual({
      type: 'text',
      data: 'Hello there',
      media_type: 'text/plain',
    });
  });

  it('still takes raw content beside a mime type', () => {
    const request = sent(
      AnthropicChatCompleteConfig,
      asking(fileOf({ file_data: PDF, mime_type: 'application/pdf' })),
    );

    expect(request.messages[0].content[1].source).toEqual({
      type: 'base64',
      data: PDF,
      media_type: 'application/pdf',
    });
  });

  it('sends a file address as a url source', () => {
    const request = sent(
      AnthropicChatCompleteConfig,
      asking(fileOf({ file_url: 'https://example.com/a.pdf' })),
    );

    expect(request.messages[0].content[1].source).toEqual({
      type: 'url',
      url: 'https://example.com/a.pdf',
    });
  });

  it('refuses a file it cannot read rather than leaving it out', () => {
    const err = refusal(() =>
      sent(AnthropicChatCompleteConfig, asking(fileOf({ file_id: 'file-abc' }))),
    );

    expect(err).toBeInstanceOf(GatewayError);
    expect((err as GatewayError).status).toBe(400);
  });
});

describe('bedrock file parts', () => {
  const content = (part: Record<string, unknown>) =>
    sent(BedrockConverseChatCompleteConfig, asking(part)).messages[0].content[1];

  it('sends a data URL as the bytes inside it, under a name Converse takes', () => {
    expect(content(fileOf({ file_data: PDF_DATA_URL, filename: 'Q3 report.final.pdf' }))).toEqual({
      document: { format: 'pdf', name: 'Q3 report-final', source: { bytes: PDF } },
    });
  });

  it('names each document type the way Converse does', () => {
    const docx = `data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,eA==`;

    expect(content(fileOf({ file_data: docx })).document.format).toBe('docx');
    expect(content(fileOf({ file_data: TEXT_DATA_URL })).document.format).toBe('txt');
  });

  it('reads a file from S3', () => {
    expect(content(fileOf({ file_url: 's3://bucket/a.pdf' }))).toMatchObject({
      document: { format: 'pdf', source: { s3Location: { uri: 's3://bucket/a.pdf' } } },
    });
  });

  it('refuses a file at a web address, which it cannot fetch', () => {
    const err = refusal(() => content(fileOf({ file_url: 'https://example.com/a.pdf' })));

    expect((err as GatewayError).status).toBe(400);
  });

  it('refuses an image at a web address rather than failing on it', () => {
    const err = refusal(() =>
      content({ type: 'image_url', image_url: { url: 'https://example.com/cat.png' } }),
    );

    expect(err).toBeInstanceOf(GatewayError);
    expect((err as GatewayError).status).toBe(400);
  });

  it('still sends an image given as a data URL', () => {
    expect(
      content({ type: 'image_url', image_url: { url: 'data:image/png;base64,iVBO' } }),
    ).toEqual({ image: { format: 'png', source: { bytes: 'iVBO' } } });
  });

  it('refuses a file named by id alone', () => {
    const err = refusal(() => content(fileOf({ file_id: 'file-abc' })));

    expect((err as GatewayError).status).toBe(400);
  });
});

describe.each([
  ['google', GoogleChatCompleteConfig],
  ['vertex-ai', VertexGoogleChatCompleteConfig],
])('%s file parts', (_provider, config) => {
  const parts = (part: Record<string, unknown>) =>
    sent(config, asking(part, 'gemini-2.5-flash')).contents[0].parts;

  it('sends a data URL inline', () => {
    expect(parts(fileOf({ file_data: PDF_DATA_URL }))[1]).toEqual({
      inlineData: { mimeType: 'application/pdf', data: PDF },
    });
  });

  it('sends a file address for Gemini to fetch', () => {
    expect(parts(fileOf({ file_url: 'gs://bucket/a.pdf' }))[1]).toEqual({
      fileData: { mimeType: 'application/pdf', fileUri: 'gs://bucket/a.pdf' },
    });
  });

  it('refuses a file named by id alone', () => {
    const err = refusal(() => parts(fileOf({ file_id: 'file-abc' })));

    expect((err as GatewayError).status).toBe(400);
  });
});

describe('responses file inputs', () => {
  it('carries a file address through to the chat completion', () => {
    const result = transformResponsesToChatCompletions({
      model: 'claude-sonnet-4-5',
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'Summarise this' },
            { type: 'input_file', file_url: 'https://example.com/a.pdf' },
          ],
        },
      ],
    } as any);

    expect((result.messages as any[])[0].content[1].file.file_url).toBe(
      'https://example.com/a.pdf',
    );
  });

  it('refuses an image named by an uploaded file id, which no chat completion can carry', () => {
    const { refused } = findUnsupportedResponsesFields({
      input: [{ role: 'user', content: [{ type: 'input_image', file_id: 'file-abc' }] }],
    });

    expect(refused).toContain('input_image.file_id');
  });

  it('leaves an image given by its address alone', () => {
    const { refused } = findUnsupportedResponsesFields({
      input: [
        {
          role: 'user',
          content: [{ type: 'input_image', image_url: 'https://example.com/cat.png' }],
        },
      ],
    });

    expect(refused).toEqual([]);
  });
});
