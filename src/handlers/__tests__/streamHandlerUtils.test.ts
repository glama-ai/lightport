import { describe, expect, it } from 'vitest';
import {
  createLineSplitter,
  getFormdataToFormdataStreamTransformer,
  getOctetStreamToOctetStreamTransformer,
} from '../streamHandlerUtils';

const BOUNDARY = 'FormBoundaryUnderTest';

/**
 * A multipart body carrying one JSONL file field, as an upload arrives.
 */
const buildBody = (rows: Record<string, unknown>[], fields: Record<string, string> = {}) =>
  Object.entries(fields)
    .map(
      ([name, value]) =>
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    )
    .join('') +
  `--${BOUNDARY}\r\n` +
  'Content-Disposition: form-data; name="file"; filename="batch.jsonl"\r\n' +
  'Content-Type: application/jsonl\r\n' +
  '\r\n' +
  rows.map((row) => JSON.stringify(row)).join('\n') +
  '\n' +
  `\r\n--${BOUNDARY}--`;

/**
 * Feeds the body through the transformer as the given pieces, the way a body
 * larger than one read arrives, and returns what came out the other end.
 */
const feed = async (body: string, pieces: string[]): Promise<string> => {
  const transformer = getFormdataToFormdataStreamTransformer(
    { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
    (row) => row,
    {},
  );

  const encoder = new TextEncoder();
  const writer = transformer.writable.getWriter();

  const written = (async () => {
    for (const piece of pieces) if (piece) await writer.write(encoder.encode(piece));
    await writer.close();
  })();

  const decoder = new TextDecoder();
  let out = '';
  for await (const piece of transformer.readable as any) {
    out += decoder.decode(piece, { stream: true });
  }
  await written;

  return out;
};

/** The body split in two at exactly `cut`. */
const runAt = (body: string, cut: number) => feed(body, [body.slice(0, cut), body.slice(cut)]);

/**
 * Feeds the body through the transformer in pieces of the given size.
 */
const run = async (body: string, chunkSize: number): Promise<string> => {
  const transformer = getFormdataToFormdataStreamTransformer(
    { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
    (row) => row,
    {},
  );

  const encoder = new TextEncoder();
  const writer = transformer.writable.getWriter();

  const written = (async () => {
    for (let at = 0; at < body.length; at += chunkSize) {
      await writer.write(encoder.encode(body.slice(at, at + chunkSize)));
    }
    await writer.close();
  })();

  const decoder = new TextDecoder();
  let out = '';
  for await (const piece of transformer.readable as any) {
    out += decoder.decode(piece, { stream: true });
  }
  await written;

  return out;
};

// What was written into the body has to be what comes out of it. Anything else
// is a file the caller uploaded and the provider stored differently, with
// nothing raised to say so.
const rowsIn = (out: string) =>
  out
    .split('\r\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line));

describe('a multipart upload split across reads', () => {
  const rows = [
    { custom_id: 'a', body: { model: 'm', messages: [{ role: 'user', content: 'one' }] } },
    { custom_id: 'b', body: { model: 'm', messages: [{ role: 'user', content: 'two' }] } },
    { custom_id: 'c', body: { model: 'm', messages: [{ role: 'user', content: 'three' }] } },
  ];

  it('arrives whole when the body comes in one piece', async () => {
    const body = buildBody(rows);

    expect(rowsIn(await run(body, body.length))).toEqual(rows);
  });

  it.each([16, 32, 64, 128])('arrives whole when it comes %i bytes at a time', async (size) => {
    // A chunk ending before the closing boundary is the case `indexOf` reports
    // as -1. Read as a position, the headers of the part were taken from the
    // wrong place and the part treated as though they had all arrived.
    const body = buildBody(rows);

    expect(rowsIn(await run(body, size))).toEqual(rows);
  });

  it('reads the same rows however it is cut up', async () => {
    const body = buildBody(rows);
    const whole = await run(body, body.length);

    for (const size of [8, 17, 33, 71]) {
      expect(rowsIn(await run(body, size))).toEqual(rowsIn(whole));
    }
  });

  it.each([
    ['a row that will never parse', `{"custom_id":"a"}\nnot json at all\n{"custom_id":"b"}\n`],
    ['rows ending in a carriage return', `{"custom_id":"a"}\r\n{"custom_id":"b"}\r\n`],
  ])('closes the body it opened around %s', async (_name, fileBody) => {
    // These are the two shapes the row reader is the whole difference on: a row
    // that fails to parse, and one whose newline is preceded by a carriage
    // return. A body of nothing but plain valid rows never tells them apart.
    const body =
      `--${BOUNDARY}\r\n` +
      'Content-Disposition: form-data; name="file"; filename="batch.jsonl"\r\n\r\n' +
      fileBody +
      `\r\n--${BOUNDARY}--`;
    const unclosed: number[] = [];

    for (let cut = 1; cut < body.length; cut++) {
      if (!(await runAt(body, cut)).trimEnd().endsWith('--')) unclosed.push(cut);
    }

    expect(unclosed).toEqual([]);
  });

  it('closes the body it opened, wherever it was cut', async () => {
    // The rows are only half of it: a body whose closing delimiter never
    // arrives is not a body the provider can read, and reading the rows alone
    // is how that went unnoticed. The delimiter opening a part and the one
    // closing the body differ by two characters, so a read ending between them
    // is the case that used to decide wrongly and then wait forever.
    const body = buildBody(rows);
    const unclosed: number[] = [];

    for (let cut = 1; cut < body.length; cut++) {
      const out = await runAt(body, cut);
      if (!out.trimEnd().endsWith('--')) unclosed.push(cut);
    }

    expect(unclosed).toEqual([]);
  });

  it('survives a field before the file that splits across reads', async () => {
    // The field is skipped rather than sent on, and skipping it used to take
    // the rest of the buffer with it — including the opening of the boundary
    // that ends it, which then went unrecognised and carried the file away too.
    // It only shows with a field long enough to span a read, which is why a
    // body of one file part never caught it.
    const body = buildBody(rows, { purpose: 'batch-value-long-enough-to-split' });

    for (let size = 8; size <= 60; size++) {
      expect({ size, rows: rowsIn(await run(body, size)) }).toEqual({ size, rows });
    }
  });
});

describe('batch output read in pieces', () => {
  const readRows = async (chunks: string[]) => {
    const transformer = getOctetStreamToOctetStreamTransformer((row) => row);
    const encoder = new TextEncoder();
    const writer = transformer.writable.getWriter();

    const written = (async () => {
      for (const chunk of chunks) await writer.write(encoder.encode(chunk));
      await writer.close();
    })();

    const decoder = new TextDecoder();
    let out = '';
    for await (const piece of transformer.readable as any) {
      out += decoder.decode(piece, { stream: true });
    }
    await written;

    return out.split('\r\n').filter(Boolean);
  };

  it('reads each row once', async () => {
    // A row that did not parse left the buffer where it was while the rows after
    // it were counted off regardless, so the two disagreed from there on and
    // what was left over came round again on the next read.
    expect(await readRows(['G'.repeat(40) + '\n{"a":1}\n', '{"b":2}\n'])).toEqual([
      '{"a":1}',
      '{"b":2}',
    ]);
  });

  it('waits for a row split across reads rather than reading half of it', async () => {
    expect(await readRows(['{"a":1}\n{"b":', '2}\n'])).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('reads past a row it cannot parse rather than offering it again', async () => {
    // The row is whole, so no later byte will make it parse. Held, it would come
    // round on every read that followed — and, since the next row is looked for
    // from where the last one ended, would be looked for for ever.
    expect(await readRows(['{"a":1}\nnot json at all\n{"b":2}\n'])).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('reads the last row of a file that ends without a newline', async () => {
    // A row is only whole once its newline has arrived, and the last row of a
    // file need not have one. Held for a read that never comes, it is dropped —
    // and the file this reads back is written elsewhere, so its last byte is
    // not this gateway's to decide.
    expect(await readRows(['{"a":1}\n{"b":2}'])).toEqual(['{"a":1}', '{"b":2}']);
    expect(await readRows(['{"a":1}'])).toEqual(['{"a":1}']);
    expect(await readRows(['{"a":1}\n{"b":', '2}'])).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('reads rows ending in a carriage return', async () => {
    expect(await readRows(['{"a":1}\r\n{"b":2}\r\n'])).toEqual(['{"a":1}', '{"b":2}']);
  });
});

/**
 * Feeds the given pieces through the line splitter and answers with whatever it
 * put out, untouched — the point here being what the pieces are made of, not
 * only what they say.
 */
const splitLines = async (pieces: string[]): Promise<unknown[]> => {
  const splitter = createLineSplitter();
  const encoder = new TextEncoder();
  const writer = splitter.writable.getWriter();

  const written = (async () => {
    for (const piece of pieces) await writer.write(encoder.encode(piece));
    await writer.close();
  })();

  const lines: unknown[] = [];
  for await (const line of splitter.readable as any) lines.push(line);
  await written;

  return lines;
};

describe('a line splitter reading a file that ends without a newline', () => {
  it('answers the last line as bytes, as it answers every line before it', async () => {
    // The line held back for a newline that never comes is read at the end of
    // the stream, and went out as the string it was held as, where every line
    // before it went out encoded. The upload reading these lines decodes each
    // one, and a string is not something to decode: the read threw, the catch
    // around it dropped the line, and the last row of the file never reached
    // the provider — leaving the body short of the length the upload was
    // signed for, with nothing said.
    const lines = await splitLines(['{"a":1}\n{"b":2}']);

    expect(lines.every((line) => line instanceof Uint8Array)).toBe(true);

    const decoder = new TextDecoder();
    expect(lines.map((line) => decoder.decode(line as Uint8Array))).toEqual(['{"a":1}', '{"b":2}']);
  });
});
