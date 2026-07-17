/**
 * Lightport - Lightweight AI Gateway
 *
 * @module index
 */

import { version } from '../package.json';
import { HEADER_KEYS } from './globals';
import { chatCompletionsHandler } from './handlers/chatCompletionsHandler';
import { completionsHandler } from './handlers/completionsHandler';
import modelResponsesHandler from './handlers/modelResponsesHandler';
import { logger } from './logger';
import { parseBody } from './middlewares/lightport';
import { requestValidator } from './middlewares/requestValidator';
import { captureException } from './sentry/captureException';
import { setRequestTags } from './sentry/setRequestTags';
import { withRequestScope } from './sentry/withRequestScope';
import type { GatewayContext } from './types/GatewayContext';
import { getCORSValues } from './utils';
import cors from '@fastify/cors';
import Fastify from 'fastify';
import type { FastifyRequest, FastifyReply, FastifyHttpsOptions } from 'fastify';

type AppLifecycle = {
  getStatus?: () => 'running' | 'terminating';
};

const createApp = (opts?: FastifyHttpsOptions<any>, lifecycle: AppLifecycle = {}) => {
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

  const sendWebResponse = async (reply: FastifyReply, response: Response) => {
    reply.hijack();

    const raw = reply.raw;
    raw.writeHead(response.status, Object.fromEntries(response.headers));

    if (!response.body) {
      raw.end();
      return;
    }

    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        // Node reports a vanished caller by destroying the socket rather than by
        // throwing — write() merely returns false — so this has to be checked
        // for. Without it the pump runs the whole stream into a dead socket.
        if (raw.destroyed) break;
        raw.write(value);
      }
    } catch {
      // Either the upstream stream failed, or the provider fetch was aborted
      // because the caller went away. Nothing further can be written.
    } finally {
      void reader.cancel().catch(() => {});
      if (!raw.destroyed) {
        raw.end();
      }
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

  const handleRoute = (handler: (c: GatewayContext) => Promise<Response>): any => {
    return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      return withRequestScope(async () => {
        const c = createGatewayContext(request, reply);

        // A caller that hangs up mid-stream leaves the provider request running,
        // and the provider goes on billing for every token it generates. Node
        // signals this by destroying the socket, so there is no error to catch —
        // it has to be watched for. tryPost wires this into the provider fetch,
        // which is the only thing that actually stops the meter.
        const callerGone = new AbortController();
        reply.raw.once('close', () => {
          if (!reply.raw.writableEnded) {
            callerGone.abort();
          }
        });
        c.set('clientAbortSignal', callerGone.signal);

        // Tagged from the headers first so that a body that fails to parse still
        // leaves an exception we can place. `tryPost` refines these once the
        // provider and model are resolved rather than merely requested.
        setRequestTags({
          provider: request.headers[HEADER_KEYS.PROVIDER],
          route: request.routeOptions.url,
          traceId: request.headers[HEADER_KEYS.TRACE_ID],
        });

        await parseBody(request, c);

        const { bodyJSON } = c.get('requestBodyData');

        setRequestTags({
          model: bodyJSON?.model,
          stream: Boolean(bodyJSON?.stream),
        });

        const validationResponse = requestValidator(c);
        if (validationResponse instanceof Response) {
          await sendWebResponse(reply, validationResponse);
          return;
        }

        const response = await handler(c);
        await sendWebResponse(reply, response);
      });
    };
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
