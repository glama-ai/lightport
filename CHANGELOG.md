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
- Non-streaming responses dropped whatever reasoning field the provider sent,
  across twelve of them — 302ai, DeepInfra, DeepSeek, Latitude, Lingyi, Mistral,
  Moonshot, nCompass, Novita, Perplexity, Together and Zhipu. Each rebuilt the
  message field by field and kept only what it named, so a reasoner model
  answering without a stream came back with its thinking missing, and a turn
  spent entirely on reasoning came back empty — indistinguishable from a model
  that said nothing. Most of the streaming halves forward the delta whole and
  never lost it, which is the only reason this stayed hidden. Confirmed against
  DeepSeek, Moonshot and Zhipu, whose reasoners document the field; for the rest
  the field is now carried rather than dropped, whether or not they send it.
- The same rebuilds dropped `completion_tokens_details` and the cache counters,
  so reasoning tokens were billed but never reported — in every provider above
  except Perplexity, which reports its counts differently, and in Predibase,
  which never dropped the reasoning itself.
- `logprobs` was accepted as a request parameter by DeepSeek, Novita and Together
  and then discarded on the way back, the last two by returning a hardcoded null.
- Predibase carried the message whole and so never lost the reasoning itself, but
  never offered it as a content block either, which is the only form the Messages
  and Responses adapters read. Through those a reasoner's thinking arrived as
  nothing at all.
- Perplexity reported an empty finish reason whatever the model did, which left
  a truncated answer looking exactly like a complete one. It also dropped the
  reasoning, citation and cost counts it charges for, which it reports beside
  the three token counts rather than under a breakdown.
- Novita numbered every answer zero, so asking for more than one returned a set
  that all claimed to be the first. Its streaming half rebuilt each delta as
  content alone — losing the role, the reasoning and any tool call — reported an
  empty finish reason throughout, forwarded only the first choice, and dropped
  usage entirely.
