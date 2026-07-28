import { addStage, getRequestTiming, type RequestTiming } from './requestTiming';
import diagnosticsChannel from 'node:diagnostics_channel';

type UndiciRequest = object;

type UpstreamMarks = {
  createdAt: number;
  sentAt?: number;
  timing: RequestTiming;
};

/**
 * Keyed on undici's own request object rather than on async context.
 *
 * `create` is published while dispatching, so it still runs in the caller's
 * context and can find the record; everything after it is published from socket
 * events, which belong to whichever request happened to wake the connection.
 * Carrying the record on the request object is what survives that hand-off. The
 * map is weak so a request undici drops without ever answering — a connection
 * reset mid-flight — cannot pin the record in memory.
 */
const inFlightRequests = new WeakMap<UndiciRequest, UpstreamMarks>();

let observing = false;

/**
 * Splits time spent upstream into waiting for a socket and waiting for the
 * provider.
 *
 * Between dispatching a request and its bytes reaching the wire sits everything
 * the gateway controls: queueing behind a busy connection, DNS, the TCP connect,
 * the TLS handshake. After that point the gateway is only waiting. A request
 * that takes three minutes is a completely different problem depending on which
 * side of `sendHeaders` those minutes fall on, and nothing observable from
 * outside the process distinguishes them.
 */
export const observeUpstreamTiming = (): void => {
  if (observing) {
    return;
  }

  observing = true;

  diagnosticsChannel.subscribe('undici:request:create', (message) => {
    const timing = getRequestTiming();

    if (!timing) {
      return;
    }

    const { request } = message as { request: UndiciRequest };

    inFlightRequests.set(request, { createdAt: performance.now(), timing });
  });

  diagnosticsChannel.subscribe('undici:client:sendHeaders', (message) => {
    const { request } = message as { request: UndiciRequest };
    const marks = inFlightRequests.get(request);

    if (!marks) {
      return;
    }

    marks.sentAt = performance.now();

    addStage(marks.timing, 'socket', marks.sentAt - marks.createdAt);
  });

  diagnosticsChannel.subscribe('undici:request:headers', (message) => {
    const { request } = message as { request: UndiciRequest };
    const marks = inFlightRequests.get(request);

    if (marks?.sentAt === undefined) {
      return;
    }

    addStage(marks.timing, 'ttfb', performance.now() - marks.sentAt);

    inFlightRequests.delete(request);
  });

  diagnosticsChannel.subscribe('undici:request:error', (message) => {
    const { request } = message as { request: UndiciRequest };
    const marks = inFlightRequests.get(request);

    if (!marks) {
      return;
    }

    // A request that fails before its headers land still spent whatever it spent
    // getting there, and attributing it is the whole point when the failure is a
    // timeout: the stage it died in is the stage that was too slow.
    const failedAt = performance.now();

    addStage(
      marks.timing,
      marks.sentAt === undefined ? 'socket' : 'ttfb',
      failedAt - (marks.sentAt ?? marks.createdAt),
    );

    inFlightRequests.delete(request);
  });
};
