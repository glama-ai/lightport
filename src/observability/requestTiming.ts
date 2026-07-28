import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The stages a request passes through, in the order they occur.
 *
 * The two that carry the diagnostic weight are `socket` and `ttfb`. A gateway
 * that is slow and a provider that is slow look identical from outside — the
 * caller sees one duration either way — and every other question about a slow
 * request is downstream of telling those two apart.
 */
export type StageName =
  | 'parse' // reading and parsing the caller's body
  | 'validate' // header and config validation
  | 'transform' // gateway params to provider request
  | 'socket' // dispatch until the request bytes reach the wire
  | 'ttfb' // request sent until the provider's response headers arrive
  | 'read' // reading the provider body and transforming the response
  | 'send'; // writing the response back to the caller

const STAGE_DESCRIPTIONS: Record<StageName, string> = {
  parse: 'parse request body',
  read: 'read provider response',
  send: 'write response to caller',
  socket: 'acquire upstream socket',
  transform: 'build provider request',
  ttfb: 'provider time to first byte',
  validate: 'validate request',
};

export type RequestAttributes = {
  model?: unknown;
  provider?: unknown;
  status?: number;
  stream?: boolean;
};

export type RequestTiming = {
  readonly attributes: RequestAttributes;
  readonly stages: Map<StageName, number>;
  readonly startedAt: number;
};

const storage = new AsyncLocalStorage<RequestTiming>();

let inFlight = 0;

export const getInFlight = (): number => inFlight;

export const getRequestTiming = (): RequestTiming | undefined => storage.getStore();

/**
 * Runs a request with a timing record attached for its whole life, and keeps the
 * in-flight count honest whether it ends by returning or by throwing.
 *
 * The count is decremented after the callback settles, so a request logging its
 * own completion still counts itself — "12 in flight" means twelve including
 * this one, which is the reading that makes sense when scanning a log.
 */
export const runWithRequestTiming = <T>(
  callback: (timing: RequestTiming) => Promise<T>,
): Promise<T> => {
  const timing: RequestTiming = {
    attributes: {},
    stages: new Map(),
    startedAt: performance.now(),
  };

  inFlight += 1;

  return storage
    .run(timing, () => callback(timing))
    .finally(() => {
      inFlight -= 1;
    });
};

/**
 * Adds to a stage on a record named explicitly rather than found by context.
 *
 * The upstream stages are timed from diagnostics channel callbacks, which run on
 * socket events belonging to whichever request happened to wake the connection.
 * Their async context is therefore not the context of the request being timed,
 * so the record has to be carried to them rather than looked up.
 */
export const addStage = (
  timing: RequestTiming | undefined,
  name: StageName,
  durationMs: number,
): void => {
  if (!timing) {
    return;
  }

  timing.stages.set(name, (timing.stages.get(name) ?? 0) + durationMs);
};

export const recordStage = (name: StageName, durationMs: number): void => {
  addStage(storage.getStore(), name, durationMs);
};

export const measureStage = async <T>(name: StageName, callback: () => Promise<T>): Promise<T> => {
  const startedAt = performance.now();

  try {
    return await callback();
  } finally {
    recordStage(name, performance.now() - startedAt);
  }
};

// Long enough for any real model or provider name, short enough that no caller
// can decide how much gets written to disk on its behalf.
const MAX_ATTRIBUTE_LENGTH = 200;

/**
 * `model` and `provider` are read straight off the request body and headers
 * before anything has validated them, and the body may be megabytes. Left whole
 * they would let a caller choose the size of the log line it costs to serve it,
 * so they are collapsed and clipped the same way the Sentry tags are.
 */
const toAttributeValue = (value: unknown): unknown => {
  if (typeof value !== 'string') {
    return value;
  }

  const normalized = value.replace(/\s+/g, ' ').trim();

  return normalized === '' ? undefined : normalized.slice(0, MAX_ATTRIBUTE_LENGTH);
};

/**
 * Records what the request was for. Safe to call repeatedly to refine: `tryPost`
 * knows the provider actually resolved from the config, which is the only
 * accurate value when a config carries `targets` and names no provider in a
 * header. Values that resolve to nothing are skipped rather than cleared, so a
 * later refinement never blanks out what an earlier call established.
 */
export const describeRequest = (attributes: RequestAttributes): void => {
  const timing = storage.getStore();

  if (!timing) {
    return;
  }

  for (const [key, raw] of Object.entries(attributes)) {
    const value = toAttributeValue(raw);

    if (value !== undefined && value !== null) {
      (timing.attributes as Record<string, unknown>)[key] = value;
    }
  }
};

const round = (value: number): number => Math.round(value * 10) / 10;

export const elapsed = (timing: RequestTiming): number => performance.now() - timing.startedAt;

export const toStageDurations = (timing: RequestTiming): Record<string, number> => {
  const durations: Record<string, number> = { total: round(elapsed(timing)) };

  for (const [name, duration] of timing.stages) {
    durations[name] = round(duration);
  }

  return durations;
};

/**
 * Formats the record as a `Server-Timing` header value.
 *
 * Only stages finished before the response headers go out can appear here, which
 * for a buffered response is everything except the write to the caller, and for
 * a stream is everything up to the provider's first byte. The log line is what
 * covers the rest — and what covers the requests whose caller gave up and will
 * never read a header at all.
 */
export const toServerTiming = (timing: RequestTiming): string => {
  const metrics = [`total;dur=${round(elapsed(timing))}`];

  for (const [name, duration] of timing.stages) {
    metrics.push(`${name};dur=${round(duration)};desc="${STAGE_DESCRIPTIONS[name]}"`);
  }

  return metrics.join(', ');
};
