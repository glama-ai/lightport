import { fileExtensionMimeTypeMap } from '../../globals';
import type { ContentType } from '../../types/requestBody';

/**
 * A file a caller sent, read into what a provider needs to send it on.
 *
 * `data` is the file's content: base64 when it came as a data URL, and
 * otherwise exactly as the caller wrote `file_data`, which is how the providers
 * were first written to take it. `fromDataUrl` says which.
 */
export type ReadFile = {
  mimeType: string;
  name?: string;
} & ({ data: string; fromDataUrl: boolean; url?: undefined } | { url: string; data?: undefined });

/**
 * The parts of a data URL, with its payload as base64 whichever way it was
 * encoded. Nothing if it is not one.
 */
export const parseDataUrl = (value: string): { mimeType: string; base64: string } | undefined => {
  if (!value.startsWith('data:')) return undefined;

  const comma = value.indexOf(',');
  if (comma === -1) return undefined;

  const [mimeType, ...parameters] = value.slice('data:'.length, comma).split(';');
  const payload = value.slice(comma + 1);
  const base64 = parameters.includes('base64')
    ? payload
    : Buffer.from(decodeURIComponent(payload)).toString('base64');

  return { mimeType: mimeType || 'text/plain', base64 };
};

/** The MIME type a file name's extension implies, if it implies one. */
export const mimeTypeOfName = (name: string | undefined): string | undefined => {
  const extension = name?.split('.').pop()?.toLowerCase();

  return extension && extension !== name?.toLowerCase()
    ? (fileExtensionMimeTypeMap as Record<string, string>)[extension]
    : undefined;
};

/**
 * Reads a `file` content part, written either as OpenAI writes one —
 * `file_data` a data URL, the name as `filename` — or as this gateway's
 * providers first took one, raw content beside a `mime_type` and `file_name`.
 *
 * Only the second was understood. A file from an OpenAI client, the Responses
 * adapter's included, reached Anthropic and Bedrock with its data URL where raw
 * base64 belonged and was refused, and reached Gemini not at all.
 *
 * Nothing when the part names its file by id alone, which only the provider
 * that issued the id can read.
 */
export const readFilePart = (file: ContentType['file']): ReadFile | undefined => {
  const name = file?.filename ?? file?.file_name;
  const named = (mimeType?: string) =>
    mimeType || file?.mime_type || mimeTypeOfName(name) || fileExtensionMimeTypeMap.pdf;

  if (file?.file_data) {
    const dataUrl = parseDataUrl(file.file_data);

    return dataUrl
      ? { data: dataUrl.base64, fromDataUrl: true, mimeType: dataUrl.mimeType, name }
      : { data: file.file_data, fromDataUrl: false, mimeType: named(), name };
  }

  if (file?.file_url) {
    return { mimeType: named(), name, url: file.file_url };
  }

  return undefined;
};

/** What to tell a caller whose file part a provider cannot read. */
export const unreadableFileMessage = (provider: string, file: ContentType['file']) =>
  file?.file_id
    ? `${provider} cannot read a file by its id; send its content as file_data or its address as file_url`
    : `A file part sent to ${provider} has neither file_data nor file_url`;
