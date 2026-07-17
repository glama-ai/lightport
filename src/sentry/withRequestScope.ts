import { withIsolationScope } from '@sentry/node-core/light';

/**
 * Runs a request inside its own Sentry isolation scope, so tags set anywhere
 * during that request reach every exception captured while handling it without
 * leaking into concurrent requests.
 *
 * Sentry's own `httpIntegration` forks an isolation scope too, but only off the
 * real HTTP server's `request` event. Forking here instead keeps the isolation
 * explicit rather than an implicit side effect of a default integration, and it
 * also covers `app.inject()`, which never touches the HTTP server.
 *
 * The AsyncLocalStorage strategy that backs this is installed by `Sentry.init`.
 * Without a DSN there is no client, so `init` is skipped and this degrades to a
 * no-op wrapper over a scope nothing ever reads.
 */
export const withRequestScope = <T>(callback: () => T): T => {
  return withIsolationScope(callback);
};
