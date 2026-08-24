import { captureException } from '../sentry/captureException';
import { parseJson } from '../utils/parseJson';
import { Transform } from 'stream';

/**
 * Returns the boundary from the content-type header of a multipart/form-data request.
 * @param contentType - The content-type header of the original request.
 * @returns The boundary string.
 * @throws {Error} Throws an error if no boundary is found in the content-type header.
 */
const getBoundaryFromContentType = (contentType: string | null): string => {
  const match = contentType?.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!match) throw new Error('No boundary in content-type');
  return match[1] || match[2];
};

/**
 * Transforms the key of the current field in the multipart/form-data request body using the fieldsMapping.
 * @param headers - The headers of the current multipart/form-data field.
 * @param fieldsMapping - The mapping of the fields.
 * @returns The transformed headers.
 */
const transformHeaders = (headers: string, fieldsMapping: Record<string, string>) => {
  const field = Object.keys(fieldsMapping).find((key) => headers.includes(`name="${key}"`));
  if (!field) return headers;
  return headers.replace(`name="${field}"`, `name="${fieldsMapping[field]}"`);
};

/**
 * Enqueues the value of the current field in the multipart/form-data request body.
 * (This currently does not transform the value)
 * @param chunk - The current chunk of the multipart/form-data body.
 * @param controller - The controller for the TransformStream.
 * @param buffer - The buffer to be updated.
 * @returns The updated buffer.
 */
const enqueueFieldValueAndUpdateBuffer = (
  chunk: string,
  controller: TransformStreamDefaultController,
  buffer: string,
) => {
  controller.enqueue(new TextEncoder().encode(chunk));
  return buffer.slice(chunk.length);
};

/**
 * Sends on every whole row in `text` and answers with how much of it was read.
 *
 * A row is whole once its newline has arrived; anything after the last newline
 * is the beginning of a row still being read, and is left where it is.
 *
 * Rows used to be counted off a split of the text while the buffer was advanced
 * by each row's own length. That went wrong two ways. A row whose newline was
 * preceded by a carriage return was one byte longer than it was counted, so the
 * carriage return went with it — and where that carriage return was the one
 * before a form's closing delimiter, the delimiter was never recognised and the
 * body went out with nothing to close it. Separately, a row that did not parse
 * left the buffer where it was while the rows after it were counted regardless,
 * so from there the two disagreed: bytes were cut from the wrong place, and a
 * row could be read a second time — in the batch output of a whole file,
 * arriving as one.
 *
 * A row that does not parse is read past rather than held. It is already whole,
 * so no later byte will make it parse; holding it would offer it up again on
 * every read that followed, and here, where the next row is looked for from
 * where the last one ended, would leave this looking for the same newline
 * without end.
 *
 * The count answers for `text`, and the multipart caller slices its own buffer
 * by it — which is sound only because the text it passes is that buffer's own
 * leading bytes.
 */
const enqueueCompleteRows = (
  text: string,
  controller: TransformStreamDefaultController,
  rowTransform: (row: Record<string, any>) => Record<string, any>,
): number => {
  const encoder = new TextEncoder();
  let read = 0;

  for (;;) {
    const newline = text.indexOf('\n', read);
    if (newline === -1) break;

    const row = text.slice(read, newline);
    read = newline + 1;

    if (row.trim() === '') continue;

    try {
      const json = parseJson<Record<string, any>>(row);
      controller.enqueue(encoder.encode(JSON.stringify(rowTransform(json))));
      controller.enqueue(encoder.encode('\r\n'));
    } catch (error) {
      captureException({ error, message: 'failed to parse JSON line in stream transform' });
    }
  }

  return read;
};

/**
 * Enqueues the file content and updates the buffer for each jsonl row in the multipart/form-data body.
 * @param chunk - The current chunk of the multipart/form-data body.
 * @param controller - The controller for the TransformStream.
 * @param buffer - The buffer to be updated.
 * @param rowTransform - The function used to transform the row.
 * @returns The updated buffer.
 */
const enqueueFileContentAndUpdateBuffer = (
  chunk: string,
  controller: TransformStreamDefaultController,
  buffer: string,
  rowTransform: (row: Record<string, any>) => Record<string, any>,
) => {
  return buffer.slice(enqueueCompleteRows(chunk, controller, rowTransform));
};

/**
 * Enqueues the file content and updates the buffer for each jsonl row in the multipart/form-data body.
 * @param chunk - The current chunk of the multipart/form-data body.
 * @param controller - The controller for the TransformStream.
 * @param buffer - The buffer to be updated.
 * @param rowTransform - The function used to transform the row.
 * @returns The updated buffer.
 */
const enqueueFileContentAndUpdateOctetStreamBuffer = (
  controller: TransformStreamDefaultController,
  buffer: string,
  rowTransform: (row: Record<string, any>) => Record<string, any>,
) => {
  return buffer.slice(enqueueCompleteRows(buffer, controller, rowTransform));
};

/**
 * Returns an instance of TransformStream used for transforming a multipart/form-data
 * @param requestHeaders - The headers of the original request.
 * @param rowTransform - The function used to transform the row.
 * @returns An instance of TransformStream.
 */
export const getFormdataToFormdataStreamTransformer = (
  requestHeaders: Record<string, string>,
  rowTransform: (row: Record<string, any>) => Record<string, any>,
  fieldsMapping: Record<string, string>,
) => {
  const decoder = new TextDecoder();
  const boundary = '--' + getBoundaryFromContentType(requestHeaders['content-type']);
  const newBoundary = '------FormBoundary' + Math.random().toString(36).slice(2);
  requestHeaders['content-type'] = `multipart/form-data; boundary=${newBoundary.slice(2)}`;
  let buffer = '';
  let isParsingHeaders = true;
  let currentHeaders = '';
  let isFileContent = false;
  const encoder = new TextEncoder();
  let isValidField = true;

  const transformStream = new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });

      while (buffer.length > 0) {
        if (isParsingHeaders) {
          const headersEndIndex = buffer.indexOf('\r\n\r\n');

          // The headers are only all here once the blank line closing them is.
          // Read before that, `indexOf` answered -1 and was used as a position
          // regardless: the headers were taken from the wrong place, three bytes
          // were dropped off the front of what followed, and the part was
          // treated as though its headers had been read. Nothing of the file
          // survived that. A part whose headers have not arrived is left in the
          // buffer for the read that completes them.
          if (headersEndIndex === -1) break;

          // Headers are only read once the buffer begins with a boundary, so
          // this is never the -1 the other two were. Guarding it anyway made a
          // body that does not begin with one worse rather than better: the
          // preamble was read as a part of its own and announced as one, where
          // the arithmetic below merely yields an empty slice that is discarded.
          const boundaryEndIndex = buffer.indexOf(boundary) + boundary.length + 2;

          currentHeaders += buffer.slice(boundaryEndIndex, headersEndIndex);
          isFileContent = currentHeaders.includes('Content-Disposition: form-data; name="file"');
          // this will be specific to provider supported fields
          isValidField = currentHeaders.includes('Content-Disposition: form-data; name="file"');
          if (isValidField) {
            const transformedHeaders = transformHeaders(currentHeaders, fieldsMapping);
            controller.enqueue(encoder.encode(newBoundary + '\r\n'));
            controller.enqueue(encoder.encode(transformedHeaders + '\r\n\r\n'));
          }

          buffer = buffer.slice(headersEndIndex + 4);
          isParsingHeaders = false;
        }

        const boundaryIndex = buffer.indexOf(boundary);

        // `indexOf` says "not here" with -1, which is a number and so survives
        // `??` — the fallback below it never ran. A chunk arriving before its
        // closing boundary, which is every chunk of a file large enough to span
        // more than one read, was then cut at -1: the content went on without
        // its last byte, and the buffer was replaced by that byte alone,
        // dropping the rest. The file came out wrong with nothing said.
        //
        // With no boundary in sight the tail is held back rather than sent on,
        // since a boundary split across two reads begins in this one and would
        // otherwise go out as part of the file and never be recognised.
        const safeLength =
          boundaryIndex === -1 ? Math.max(0, buffer.length - (boundary.length - 1)) : boundaryIndex;

        const content = buffer.slice(0, safeLength);
        if (isFileContent) {
          buffer = enqueueFileContentAndUpdateBuffer(content, controller, buffer, rowTransform);
        } else if (isValidField) {
          buffer = enqueueFieldValueAndUpdateBuffer(content, controller, buffer);
        } else {
          buffer = buffer.slice(safeLength);
        }

        if (buffer.startsWith(`${boundary}--`)) {
          controller.enqueue(new TextEncoder().encode(`\r\n${newBoundary}--`));
          buffer = '';
        } else if (buffer.startsWith(boundary)) {
          // A delimiter opening the next part and the one closing the body
          // differ only in the two characters that follow, which may not have
          // arrived. Deciding before they have read the closing delimiter as an
          // opening one and then waited for headers that were never coming, so
          // the body went out with nothing to close it.
          if (buffer.length < boundary.length + 2) break;

          isParsingHeaders = true;
          currentHeaders = '';
        } else {
          break;
        }
      }
    },
  });
  return transformStream;
};

/**
 * Returns an instance of TransformStream used for transforming a binary/octet-stream
 * @param rowTransform - The function used to transform the row.
 * @returns An instance of TransformStream.
 */
export const getOctetStreamToOctetStreamTransformer = (
  rowTransform: (row: Record<string, any>) => Record<string, any>,
) => {
  const decoder = new TextDecoder();
  let buffer = '';

  const transformStream = new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(new Uint8Array(chunk), { stream: true });

      buffer = enqueueFileContentAndUpdateOctetStreamBuffer(controller, buffer, rowTransform);
    },
    // A row is only whole once its newline has arrived, and the last row of a
    // file need not have one. Held for a read that never comes it would be
    // dropped, so the end of the stream is where it is read: that is what the
    // two line readers below this one do, and what a file written elsewhere —
    // the batch output Bedrock leaves behind, whose last byte is not this
    // gateway's to decide — needs from us.
    flush(controller) {
      const remaining = buffer.trim();
      buffer = '';

      if (remaining) enqueueCompleteRows(`${remaining}\n`, controller, rowTransform);
    },
  });
  return transformStream;
};

export function createLineSplitter(): TransformStream {
  let leftover = '';
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  return new TransformStream({
    transform(_chunk, controller) {
      const chunk = decoder.decode(_chunk, { stream: true });
      leftover += chunk.toString();
      const lines = leftover.split('\n');
      leftover = lines.pop() || '';
      for (const line of lines) {
        if (line.trim()) {
          controller.enqueue(encoder.encode(line.trim()));
        }
      }
      return;
    },
    // The last line of a file need not end in a newline, so the line held back
    // for one goes out here — and goes out encoded, as every line before it
    // did. Sent as the string it was held as, it reached a reader that decodes
    // what it is given, which a string is not: the read threw, the catch around
    // it dropped the line, and the file went to the provider a row short of the
    // length its upload was signed for, with nothing said.
    flush(controller) {
      if (leftover.trim()) {
        controller.enqueue(encoder.encode(leftover.trim()));
      }
    },
  });
}

export const nodeLineReader = (useBatch = false) => {
  let leftOver = '';
  let linesToPush: string[] = [];
  const lineReader = new Transform({
    transform: function (chunk, encoding, callback) {
      leftOver += chunk.toString();
      const lines = leftOver.split('\n');
      leftOver = lines.pop() || '';
      for (const line of lines) {
        const trimmedLine = line.trim();
        if (trimmedLine) {
          // Batch push conditionally.
          if (useBatch) {
            if (linesToPush.length >= 50) {
              this.push(JSON.stringify(linesToPush));
              linesToPush = [];
            }
            linesToPush.push(trimmedLine);
          } else {
            this.push(trimmedLine);
          }
        }
      }
      callback();
    },
    flush(callback) {
      if (linesToPush.length > 0) {
        this.push(JSON.stringify(linesToPush));
        linesToPush = [];
      }
      if (leftOver.trim()) {
        this.push(leftOver.trim());
      }
      callback();
    },
  });

  return lineReader;
};
