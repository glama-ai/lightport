# Changelog

## Unreleased

### Breaking

**The gateway's own errors now use the OpenAI error envelope.**

Errors raised by the gateway itself — a malformed body, an invalid config, an
unhandled fault — were returned as `{"status": "failure", "message": "..."}`.
They are now returned as every provider error already was:

```json
{ "error": { "code": null, "message": "...", "param": null, "type": "invalid_request_error" } }
```

An OpenAI client could not parse the old shape, so it surfaced as an opaque
failure rather than the reason. Anything reading `body.status` or `body.message`
from a gateway error needs to read `body.error.message` instead.

**A config carrying `strategy` or `targets` is refused.**

Lightport routes each request to a single provider and resolves no targets, so
such a config named no provider and the request already failed — on
`Provider "" is not supported`, naming a provider the caller never wrote. It now
fails at validation with a 400 that says why. Handle failover and load balancing
in the caller.

`retry` and `cache` are **not** refused. They are not implemented either, and a
request carrying them is served with a warning in the log. Nothing that worked
before stops working.

### Fixed

A mid-stream failure now reaches the caller as a failure. Previously it could
arrive looking like a completed response, which no client could tell from a model
that answered and said nothing:

- A stream cut short mid-flight ended with a terminating chunk, framing a
  half-finished completion as a whole one. It now ends with an error frame in the
  vocabulary of the route being served, and the connection is dropped rather than
  closed cleanly.
- An error frame sent by a provider mid-stream was lost by that provider's chunk
  transform — thrown on by fifteen of them, which reported the failure as a
  broken connection, and silently discarded by the rest. It now survives whatever
  the transform does with it, with the provider's own `type` and `code` intact.
- The Messages and Responses adapters ended a failed stream the same way they
  ended a finished one, and dropped upstream error frames while re-framing.
- Truncation and its cause are now recorded in the log and in Sentry, which the
  caller-facing notice deliberately does not distinguish.
