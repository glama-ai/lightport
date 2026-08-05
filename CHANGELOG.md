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
- Streamed reasoning never reached the Messages or Responses APIs. The providers
  stream it as `reasoning_content`, and the adapters read only the `content_blocks`
  a handful of providers reshape it into — the Messages adapter read no reasoning
  at all. So the reasoning a caller lost was the one on the path most callers
  take. Both now read either form, and count it once where a provider sends both.
- The Messages adapter opened its text block before the model had said anything
  and numbered it zero, which left nowhere to put the thinking that precedes an
  answer. Blocks are now numbered as they are opened, and one is closed before
  the next opens, so the thinking comes first as it already did without a stream
  and no block is ever opened inside another — a `tool_use` block used to be
  started inside the text block and left open, and a second call inside the
  first. Whatever is still open is now closed when the stream ends, whether it
  ends by a finish reason or only by running out: on that second path nothing
  was closed at all.
- The Messages adapter restarted a `tool_use` block on every chunk naming the
  call, so a provider that repeats the name emitted one call as several starts at
  the same index. Arguments arriving before the call was named were sent for a
  block that had never been started, which comes to the same thing as losing
  them: the tool ran on an empty input.
- Tool calling reaches DeepInfra, Lingyi, Moonshot, nCompass and Zhipu. None of
  them named `tools`, `tool_choice` or `parallel_tool_calls` among the parameters
  they accept, and only the named ones are forwarded, so a request carrying tools
  had them removed before it was sent: the model was never told it could call
  anything and answered in prose, with nothing to say the tools had gone. Their
  responses dropped `tool_calls` for the same reason the reasoning was dropped,
  so a model that did call one came back as though it had said nothing. 302ai is
  configured the same way, but it is registered without being listed as a valid
  provider, so no request reaches it at all and nothing about it changes here.

  Confirmed against the published API for DeepInfra, Moonshot and Zhipu; Zhipu
  documents only `auto` for `tool_choice`, so a caller naming a function, or
  asking through the Responses API for `required` or `none`, is relying on
  something Zhipu does not promise. For Lingyi and nCompass the parameters are
  forwarded on the strength of their being OpenAI-compatible rather than a
  documented guarantee. A provider that does not support them will either refuse
  the request or ignore the parameters, which is what it would have done with
  any other parameter it does not know.

- A request could fail on a message the caller was entitled to send. Three
  transforms read the first element of an array without checking there was one,
  and raised where the caller expected an answer — reaching them as a 500 saying
  only that something had gone wrong, and recorded as a fault of the gateway
  rather than of the request:

  - A system or developer message whose content is `[]`, which an SDK assembling
    content from nothing will send. This is in the Anthropic transform, which is
    spread into the config for Claude on Vertex and used by Azure AI Inference,
    so all three were affected, along with the copy that builds Bedrock batch
    files. Empty content is now nothing said. The Bedrock copy matches only
    `system` where the chat transform also matches `developer`; that difference
    is untouched here, and a developer message still reaches Anthropic under a
    role it does not accept.
  - A tool result with no message before it to attach to — sent first, or after
    nothing but system messages, which are removed before this runs. It now
    stands as a message of its own, which is what a tool result already got when
    the message before it was something else.
  - A Reka conversation that produced no messages, either from empty content or
    from none sent. It now takes the same placeholder opening as a conversation
    that does not begin with a human turn.

- Bedrock reported a usage object whose parts did not sum to its total. Bedrock
  documents `inputTokens` as the non-cached input alone, the whole input being
  `inputTokens + cacheReadInputTokens + cacheWriteInputTokens`, but does not say
  which of those two its own `totalTokens` sums. Reporting the whole input as
  `prompt_tokens` while passing that total through unchanged left the two
  disagreeing whenever the cache was used. The total is now derived from the two
  counts beside it, in the streamed response as well as the whole one, which
  holds whichever of the two Bedrock meant.
