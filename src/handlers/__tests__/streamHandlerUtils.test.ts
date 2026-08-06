import { describe, expect, it } from 'vitest';
import { getFormdataToFormdataStreamTransformer } from '../streamHandlerUtils';

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
 * Feeds the body through the transformer in pieces of the given size, the way a
 * body larger than one read arrives, and returns what came out the other end.
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

  it('closes the body it opened', async () => {
    // The rows are only half of it: a body whose closing delimiter never
    // arrives is not a body the provider can read, and reading the rows alone
    // is how that went unnoticed.
    const body = buildBody(rows);

    for (const size of [16, 32, 64, 128, body.length]) {
      expect((await run(body, size)).trimEnd().endsWith('--')).toBe(true);
    }
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
