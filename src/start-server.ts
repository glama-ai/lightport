#!/usr/bin/env node
import { initializeSentry } from './sentry/initializeSentry';

initializeSentry();

import { buildAgents } from './agentStore';
import createApp from './index';
import { logger } from './logger';
import { captureException } from './sentry/captureException';
import { Environment } from './utils/env';
import minimist from 'minimist';
import { readFileSync } from 'node:fs';
import tls from 'node:tls';

const TIMEOUT = 15 * 60 * 1000; // 15 minutes
const CLOSE_DELAY = 5_000;
const FORCE_EXIT_TIMEOUT = 295_000;

const argv = minimist(process.argv.slice(2), {
  default: {
    port: Number(Environment({}).PORT),
  },
});

const port = argv.port;

const tlsKeyPath = Environment({}).TLS_KEY_PATH;
const tlsCertPath = Environment({}).TLS_CERT_PATH;
const tlsCaPath = Environment({}).TLS_CA_PATH;

let tlsKey = Environment({}).TLS_KEY;
let tlsCert = Environment({}).TLS_CERT;
let tlsCa = Environment({}).TLS_CA;
const defaultCAs = tls.rootCertificates;

if (tlsKeyPath && tlsCertPath) {
  try {
    tlsKey = readFileSync(tlsKeyPath, 'utf-8');
    tlsCert = readFileSync(tlsCertPath, 'utf-8');
    if (tlsCaPath) {
      tlsCa = readFileSync(tlsCaPath, 'utf-8');
    }
  } catch (error) {
    logger.error({ err: error }, 'error reading TLS keys');
  }
}

const agentConfig: any = {};

if ((tlsKey && tlsCert) || tlsCa) {
  agentConfig.tls = {
    ...(tlsKey && { key: tlsKey }),
    ...(tlsCert && { cert: tlsCert }),
    ...(tlsCa ? { ca: [...defaultCAs, tlsCa] } : {}),
  };
}

buildAgents(agentConfig);

const httpsOpts =
  tlsKey && tlsCert
    ? {
        https: {
          key: tlsKey,
          cert: tlsCert,
          ...(tlsCa ? { ca: [...defaultCAs, tlsCa] } : {}),
        },
      }
    : {};

let status: 'running' | 'terminating' = 'running';
let shutdownRequested = false;

const app = createApp(httpsOpts as any, {
  getStatus: () => status,
});

const requestShutdown = (signal: NodeJS.Signals) => {
  if (shutdownRequested) {
    logger.warn({ signal }, 'received second shutdown signal; forcing exit');

    // eslint-disable-next-line n/no-process-exit
    process.exit(1);
  }

  shutdownRequested = true;
  status = 'terminating';

  logger.warn(
    {
      closeDelayMs: CLOSE_DELAY,
      forceExitTimeoutMs: FORCE_EXIT_TIMEOUT,
      signal,
    },
    'shutdown signal received; draining AI gateway',
  );

  if (typeof app.server.closeIdleConnections === 'function') {
    app.server.closeIdleConnections();
  }

  setTimeout(() => {
    void app
      .close()
      .then(() => {
        logger.info('AI Gateway stopped');

        // eslint-disable-next-line n/no-process-exit
        process.exit(0);
      })
      .catch((error) => {
        logger.error({ err: error }, 'failed to stop AI Gateway');

        // eslint-disable-next-line n/no-process-exit
        process.exit(1);
      });
  }, CLOSE_DELAY).unref();

  setTimeout(() => {
    logger.error({ signal }, 'shutdown timeout exceeded; forcing exit');

    // eslint-disable-next-line n/no-process-exit
    process.exit(1);
  }, FORCE_EXIT_TIMEOUT).unref();
};

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    requestShutdown(signal);
  });
}

app.listen({ port, host: '::' }, (err) => {
  if (err) {
    logger.error({ err }, 'failed to start server');
    process.exit(1);
  }

  const server = app.server;
  server.setTimeout(TIMEOUT);
  server.requestTimeout = TIMEOUT;
  server.headersTimeout = TIMEOUT;

  logger.info({ port }, 'AI Gateway started');
});

process.on('uncaughtException', (err) => {
  logger.error({ err }, 'uncaught exception');

  captureException({
    error: err,
    message: 'uncaught exception',
  });
});

process.on('unhandledRejection', (err) => {
  logger.error({ err }, 'unhandled rejection');

  captureException({
    error: err,
    message: 'unhandled rejection',
  });
});
