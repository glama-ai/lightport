/**
 * Lightport - Lightweight AI Gateway
 *
 * @module index
 */

import { version } from '../package.json';
import { getClientAbortSignal, runWithClientAbort } from './context/clientAbort';
import { openAiErrorEventAfterPartialFrame } from './errors/openAiError';
import { CONTENT_TYPES, HEADER_KEYS } from './globals';
import { chatCompletionsHandler } from './handlers/chatCompletionsHandler';
import { completionsHandler } from './handlers/completionsHandler';
import modelResponsesHandler from './handlers/modelResponsesHandler';
import { logger } from './logger';
import { parseBody } from './middlewares/lightport';
import { requestValidator } from './middlewares/requestValidator';
import {
  describeRequest,
  getInFlight,
  getRequestTiming,
  measureStage,
  recordStage,
  runWithRequestTiming,
  toServerTiming,
  toStageDurations,
  type RequestTiming,
} from './observability/requestTiming';
import { observeUpstreamTiming } from './observability/upstreamTiming';
import { captureException } from './sentry/captureException';
import { setRequestTags } from './sentry/setRequestTags';
import { withRequestScope } from './sentry/withRequestScope';
import type { GatewayContext } from './types/GatewayContext';
import { getCORSValues } from './utils';
import cors from '@fastify/cors';
import Fastify from 'fastify';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyRequest, FastifyReply, FastifyHttpsOptions } from 'fastify';
import type { ServerResponse } from 'node:http';

type AppLifecycle = {
  getStatus?: () => 'running' | 'terminating';
};

/**
 * What a caller reading a stream is told when it stops short.
 *
 * Neutral about cause on purpose. Every exception out of the pump ends here,
 * a fault in the gateway's own transform as much as a provider that stopped
 * sending, and the caller is in no position to tell those apart — the log and
 * the Sentry event, which can, are where the distinction is drawn.
 */
const TRUNCATION_NOTICE = {
  code: 'stream_truncated',
  message: 'The response stream ended before it was complete.',
  type: 'server_error',
};

/**
 * The same notice in the vocabulary of the API the caller asked for.
 *
 * Both routes serve `text/event-stream`, but the Responses API frames an error
 * flat and names the event in the payload rather than wrapping it in `error`.
 * Sent the chat-completions envelope, a client dispatching on `type` finds no
 * `type` field at all and passes over the one frame that explains the stream it
 * is about to lose.
 *
 * Neither carries a terminal lifecycle event. `response.failed` has to name the
 * response it ends and take the next sequence number, and both live in adapter
 * state this layer never sees; inventing them would put a second, contradictory
 * ending on the stream. The error frame is what the OpenAI SDKs raise on, so a
 * caller is not left waiting either way.
 */
const TRUNCATED_STREAM_EVENTS = {
  chat: openAiErrorEventAfterPartialFrame(TRUNCATION_NOTICE),
  responses: `\n\nevent: error\ndata: ${JSON.stringify({
    code: TRUNCATION_NOTICE.code,
    message: TRUNCATION_NOTICE.message,
    param: null,
    type: 'error',
  })}\n\n`,
};

/** Which of the two a route speaks. */
const truncationEventFor = (route: string | undefined): string =>
  route?.startsWith('/v1/responses')
    ? TRUNCATED_STREAM_EVENTS.responses
    : TRUNCATED_STREAM_EVENTS.chat;

/**
 * How long the truncation notice is given to reach the caller.
 *
 * Only a caller that has stopped reading can hold the write open, and one that
 * has stopped reading is not going to see the notice however long it is given.
 */
const TRUNCATION_FLUSH_TIMEOUT = 1_000;

/**
 * Tells a caller in the body that the stream they are reading stopped short.
 *
 * `destroy()` follows immediately and discards whatever is still buffered, so
 * this waits for the frame to reach the socket rather than firing it off — a
 * notice thrown away with the connection would leave the caller back where it
 * started, inferring truncation from a transport error that any intermediary
 * between here and it is free to swallow.
 *
 * Handing the bytes to the kernel is as far as this can get: delivery to the
 * peer is not something TCP will confirm, and a reset can still discard what
 * was written. Best effort, and the hangup remains the signal for whoever
 * reads no frame at all.
 */
const announceTruncation = async (raw: ServerResponse, event: string): Promise<void> => {
  // The loser of the race is cancelled rather than left pending: during the
  // outage this exists for, truncations arrive by the hundred, and each one
  // would otherwise hold a timer for a second after it was answered.
  const flushed = new AbortController();
  const timeout = delay(TRUNCATION_FLUSH_TIMEOUT, undefined, {
    ref: false,
    signal: flushed.signal,
  });

  // Cancelling the timer rejects it. By then the race is decided and nobody is
  // waiting, so the rejection is answered here rather than left to surface as
  // an unhandled one on every truncation that flushed in time.
  timeout.catch(() => {});

  try {
    await Promise.race([
      new Promise<void>((resolve) => {
        // The callback runs on failure as well as on flush, and a write that
        // failed is one there is nothing left to wait for.
        raw.write(event, () => resolve());
      }),
      timeout,
    ]);
  } finally {
    flushed.abort();
  }
};

const createApp = (opts?: FastifyHttpsOptions<any>, lifecycle: AppLifecycle = {}) => {
  observeUpstreamTiming();

  const app = Fastify({
    logger: false,
    return503OnClosing: true,
    ...opts,
  });

  // CORS
  const { allowedOrigins, allowedMethods, allowedHeaders, allowedExposeHeaders, isCorsEnabled } =
    getCORSValues();

  if (isCorsEnabled) {
    app.register(cors, {
      origin: (origin, cb) => {
        if (!origin || allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
          cb(null, true);
        } else {
          cb(null, false);
        }
      },
      methods: allowedMethods,
      allowedHeaders,
      exposedHeaders: allowedExposeHeaders,
    });
  }

  // Disable Fastify's default JSON body parser – we parse the raw body ourselves
  // to handle multipart/form-data and binary content types.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });

  const createGatewayContext = (request: FastifyRequest, _reply: FastifyReply): GatewayContext => {
    const store = new Map<string, any>();

    return {
      req: {
        url: `${request.protocol}://${request.hostname}${request.url}`,
        method: request.method,
        param: () => (request.params as Record<string, string>) ?? {},
      },
      get: (key: string) => store.get(key),
      set: (key: string, value: any) => store.set(key, value),
    };
  };

  const sendWebResponse = async (reply: FastifyReply, response: Response, route?: string) => {
    reply.hijack();

    const raw = reply.raw;

    describeRequest({ status: response.status });

    // Nothing below can reach a caller who has already gone, and writing to a
    // destroyed response only invites an error event on a socket nobody owns.
    if (raw.destroyed) {
      return;
    }

    const timing = getRequestTiming();
    const headers = Object.fromEntries(response.headers);

    // Last moment at which any of this can still be told to the caller: once the
    // status line is out, the only remaining channel is the log.
    if (timing) {
      headers['server-timing'] = toServerTiming(timing);
    }

    raw.writeHead(response.status, headers);

    if (!response.body) {
      raw.end();
      return;
    }

    const startedWriting = performance.now();

    const callerGone = getClientAbortSignal();
    const reader = response.body.getReader();

    // What became of the body, decided at whichever of the pump's exits is
    // taken and accounted for once, below. The pump can leave three ways and
    // only one of them throws, so recording this from the catch alone left a
    // caller who vanished while the pump was parked on a full socket — the very
    // caller most likely to leave that way — logged as a delivery.
    let hangup = false;
    let failure: { err: unknown } | undefined;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        // Node reports a vanished caller by destroying the socket rather than by
        // throwing — write() merely returns false — so this has to be checked
        // for. Without it the pump runs the whole stream into a dead socket.
        if (raw.destroyed) {
          hangup = true;
          break;
        }

        // write() also returns false once the socket's buffer is full, and a
        // caller reading slower than the provider writes would otherwise have
        // its whole completion queued in memory. Waiting for drain paces the
        // pump against the socket; the caller's signal is what releases the wait
        // if they disappear rather than catch up.
        if (!raw.write(value) && !raw.destroyed) {
          try {
            await once(raw, 'drain', callerGone ? { signal: callerGone } : {});
          } catch (err) {
            // `once` rejects on the signal and on an `error` from the response
            // alike. A caller that walked away while the pump waited here is a
            // hangup; a socket that failed under it is a truncation, and filing
            // that as a hangup would discard the only report of a caller left
            // short — and end the body as though it were whole.
            if (callerGone?.aborted) {
              hangup = true;
            } else {
              failure = { err };
            }

            break;
          }
        }
      }
    } catch (err) {
      // A hangup is not a fault: the gateway aborted the provider on the
      // caller's behalf, and a cancelled writer rejects with undefined.
      // Anything else is a genuine failure.
      //
      // The signal is asked first because it is the authority on the question,
      // and it is what the pre-headers half of this policy already uses. The
      // name is only a fallback for a stream with no signal in scope: undici's
      // own RequestAbortedError is named AbortError too, so on its own it would
      // quietly file every failure on such a path as a hangup.
      const causedByHangup =
        err === undefined ||
        (callerGone?.aborted ?? (err as { name?: string })?.name === 'AbortError');

      if (causedByHangup) {
        hangup = true;
      } else {
        failure = { err };
      }
    }

    // Whatever the exit, something is recorded. `status` was written when the
    // headers went out, which for a stream is long before the body was
    // delivered, so what became of the response afterwards is not in it — and a
    // request that failed its caller, one whose caller walked away, and one
    // delivered whole are otherwise the same 200 in the log.
    if (failure) {
      // Marked before the capture below so the event reporting the failure
      // carries the tag.
      setRequestTags({ truncated: true });
      describeRequest({ truncated: true });

      logger.error({ err: failure.err }, 'response stream truncated');
      captureException({ error: failure.err, message: 'response stream truncated' });
    } else if (hangup) {
      describeRequest({ disconnected: true });
    }

    const endedEarly = hangup || Boolean(failure);

    recordStage('send', performance.now() - startedWriting);

    void reader.cancel().catch(() => {});

    if (raw.destroyed) {
      // The caller is already gone; there is nobody left to signal.
    } else if (endedEarly) {
      // The status line and headers went out long before the failure, so they
      // cannot be revised, and the body is the only channel left. A stream can
      // say it there in its own vocabulary, and being part of the payload the
      // notice reaches whoever forwards these bytes on — which is precisely
      // where the hangup below stops being legible, a proxy that has buffered
      // a body being free to end it cleanly and usually doing so. Anything
      // else the gateway streams — audio, an image, a body it never framed —
      // has no such vocabulary, and appending to it would corrupt the very
      // thing the caller is trying to salvage.
      //
      // Media types are case-insensitive and this one is the provider's, not
      // ours: streamHandler forwards it verbatim.
      const isEventStream = headers['content-type']
        ?.toLowerCase()
        .startsWith(CONTENT_TYPES.EVENT_STREAM);

      // The socket, not the response: `_writeRaw` drops the write callback
      // when the socket is gone, and the socket is marked synchronously while
      // the response only follows on the next tick. Between the two, waiting
      // on a flush that will never be reported costs the whole timeout to
      // learn what is already knowable — and there is nobody there to read it.
      if (isEventStream && !raw.socket?.destroyed) {
        // The hangup below is the signal that must not be lost. Were the
        // announcement to throw, the socket would be left open carrying
        // neither a terminating chunk nor a close, and the caller would wait
        // out a server timeout to learn nothing — strictly worse than the
        // silence this whole change is replacing.
        try {
          await announceTruncation(raw, truncationEventFor(route));
        } catch {
          // Nothing to add: the notice was best effort and the hangup says
          // it too.
        }
      }

      // Hanging up without writing the terminating chunk is what tells a
      // caller that reads neither frame. end() here would frame a
      // half-finished completion as a whole one, and no caller could tell the
      // difference.
      raw.destroy();
    } else {
      raw.end();
    }
  };

  // Health check
  app.get('/v1/health', (_request, reply) => {
    reply.send({
      status: 'success',
      message: 'Server is healthy',
      version,
    });
  });

  app.get('/checks/ready', (_request, reply) => {
    const status = lifecycle.getStatus?.() ?? 'running';

    reply.code(status === 'running' ? 200 : 503).send({
      status,
      version,
    });
  });

  app.get('/', (_request, reply) => {
    reply.type('text/plain').send('AI Gateway says hey!');
  });

  /**
   * One line per request, whatever became of it.
   *
   * `Server-Timing` reaches whoever read the response, which excludes every
   * caller that gave up waiting — the population most worth explaining. This is
   * the only account of those, and the only place the write to the caller can be
   * reported, since that finishes long after its own headers left.
   */
  const logRequest = (timing: RequestTiming, request: FastifyRequest) => {
    logger.info(
      {
        inFlight: getInFlight(),
        ms: toStageDurations(timing),
        route: request.routeOptions.url,
        traceId: request.headers[HEADER_KEYS.TRACE_ID],
        ...timing.attributes,
      },
      'request complete',
    );
  };

  const handleRoute = (handler: (c: GatewayContext) => Promise<Response>): any => {
    return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      return withRequestScope(async () => {
        return runWithRequestTiming(async (timing) => {
          try {
            await routeRequest(handler, request, reply);
          } finally {
            logRequest(timing, request);
          }
        });
      });
    };
  };

  const routeRequest = async (
    handler: (c: GatewayContext) => Promise<Response>,
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    const c = createGatewayContext(request, reply);

    // A caller that hangs up mid-stream leaves the provider request running,
    // and the provider goes on billing for every token it generates. Node
    // signals this by destroying the socket, so there is no error to catch —
    // it has to be watched for. externalServiceFetch picks the signal up
    // from here, which is the only thing that actually stops the meter.
    const callerGone = new AbortController();
    reply.raw.once('close', () => {
      if (!reply.raw.writableEnded) {
        callerGone.abort();
      }
    });

    return runWithClientAbort(callerGone.signal, async () => {
      // Tagged from the headers first so that a body that fails to parse
      // still leaves an exception we can place. `tryPost` refines these once
      // the provider and model are resolved rather than merely requested.
      setRequestTags({
        provider: request.headers[HEADER_KEYS.PROVIDER],
        route: request.routeOptions.url,
        traceId: request.headers[HEADER_KEYS.TRACE_ID],
      });

      await measureStage('parse', () => parseBody(request, c));

      const { bodyJSON } = c.get('requestBodyData');

      setRequestTags({
        model: bodyJSON?.model,
        stream: Boolean(bodyJSON?.stream),
      });

      describeRequest({
        model: bodyJSON?.model,
        provider: request.headers[HEADER_KEYS.PROVIDER],
        stream: Boolean(bodyJSON?.stream),
      });

      const validationStartedAt = performance.now();
      const validationResponse = requestValidator(c);
      recordStage('validate', performance.now() - validationStartedAt);

      if (validationResponse instanceof Response) {
        await sendWebResponse(reply, validationResponse, request.routeOptions.url);
        return;
      }

      const response = await handler(c);
      await sendWebResponse(reply, response, request.routeOptions.url);
    });
  };

  // Chat completions
  app.route({
    method: 'POST',
    url: '/v1/chat/completions',
    handler: handleRoute(chatCompletionsHandler),
  });

  // Completions
  app.route({ method: 'POST', url: '/v1/completions', handler: handleRoute(completionsHandler) });

  // Responses API
  app.route({
    method: 'POST',
    url: '/v1/responses',
    handler: handleRoute(modelResponsesHandler('createModelResponse', 'POST')),
  });
  app.route({
    method: 'GET',
    url: '/v1/responses/:id',
    handler: handleRoute(modelResponsesHandler('getModelResponse', 'GET')),
  });
  app.route({
    method: 'DELETE',
    url: '/v1/responses/:id',
    handler: handleRoute(modelResponsesHandler('deleteModelResponse', 'DELETE')),
  });
  app.route({
    method: 'GET',
    url: '/v1/responses/:id/input_items',
    handler: handleRoute(modelResponsesHandler('listResponseInputItems', 'GET')),
  });

  // 404
  app.setNotFoundHandler((_request, reply) => {
    reply.status(404).send({ message: 'Not Found', ok: false });
  });

  // Error handler
  app.setErrorHandler((err, _request, reply) => {
    logger.error({ err }, 'something went wrong');

    captureException({
      error: err,
      message: 'unhandled route error',
    });

    reply.status(500).send({
      status: 'failure',
      message: 'Internal Server Error',
    });
  });

  return app;
};

export default createApp;
