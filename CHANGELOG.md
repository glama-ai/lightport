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

**Workers AI chat completions go to a different route.**

They were sent to `…/ai/run/{model}`, which names the model in the path, and now
go to `…/ai/v1/chat/completions`, which names it in the body. What that changes
for a caller sending nothing unusual: `raw` is no longer forwarded, being a
parameter of the route no longer used; `finish_reason` is the model's own rather
than the empty string; `id` is Cloudflare's rather than a timestamp; and `usage`
is reported. Cloudflare describes the OpenAI-compatible route as serving text
generation without naming which models, so a chat model it does not serve there
is now out of reach — nothing in its documentation says there is one.

The address also changed shape. `/run` moved out of the base and into the three
endpoints that still name the model in a path, since chat completions no longer
do. A `custom_host` replaces the base entire, so one written to end where the base
used to end now sends text completions, embeddings and image generation to
`…/run/{model}` beneath it rather than `…/{model}`. Point it at the account's
`/ai` and the four endpoints address themselves.

`retry` and `cache` are **not** refused, and neither are the hooks and
guardrails. None of them is implemented, and a request carrying any is served
with a warning in the log naming which. Nothing that worked before stops working.

**A Responses request the translation cannot carry out is refused.**

Five providers serve the Responses API themselves. Every other one is served by
translating the request into a chat completion, which is a single stateless call:
nothing is kept between turns, nothing is left behind to fetch afterwards, and
the only tool the model is offered is a function the caller supplied. A request
resting on any of that used to be answered as though it had been given — a
conversation continued from a response that was never stored came back with no
memory of it, and a 200 to say all was well. These are now a 400 naming the
field:

- `previous_response_id` and `conversation`, which name a conversation held on
  the provider's side that there is none of here.
- `prompt`, a stored template whose instructions were the greater part of what
  was asked and were never fetched.
- `background: true`, which asks to return at once and be collected later —
  collecting it was already refused.
- `include`, which asks for content that will not be in the answer.
  `reasoning.encrypted_content` is how a stateless caller carries reasoning
  between turns, so losing it quietly broke the one thing this route can
  otherwise do.
- `tools` naming anything but a function. A search or an interpreter was dropped
  and the answer came back as though it had run.

`background: false` and `truncation: 'disabled'` are unaffected: asking for none
of a thing is satisfied by having none of it. `store` is not refused either — it
defaults to true upstream, so refusing it would turn on whether the caller wrote
the default down rather than on what they meant, and the one consequence not
honoured, fetching the response later, is already refused in its own right.
Nothing changes for the providers that serve the API natively, where every field
reaches the provider as before.

`truncation: 'auto'`, `service_tier`, `prompt_cache_key`, `prompt_cache_retention`,
`max_tool_calls` and `safety_identifier` are **not** refused. They ask for the
answer to be arrived at differently rather than for a different answer, so the
request still means what it said and is served — with a warning in the log naming
what nothing acted on.

### Added

**Requesty is available as a provider.** It routes to models from several houses
under names that say which — `openai/gpt-4o-mini`, `anthropic/claude-sonnet-4-5`
— behind an endpoint that is OpenAI's own shape, so it takes OpenAI's parameters
under their own names, `reasoning_effort` among them, with the same
`developer`-to-`system` rewriting every provider on that base does. Chat
completions only: Requesty answers a text completion with a 404. Set
`x-lightport-provider: requesty` and an API key from app.requesty.ai.

The response is carried whole rather than rebuilt, so nothing it sends is lost
for not having been named. What is added to it is the provider's name and the
content-block form of the reasoning: Requesty reports a model's thinking as
`reasoning_content`, and the Responses API reads a reasoning turn from
`content_blocks` when it is not streaming, so through it a reasoner would
otherwise have answered with its thinking missing. Streamed, it arrives either
way.

**Workers AI reports what a turn cost, why it stopped, and any tool it asked
for.** A completion arrived with no usage, no tool call, and a finish reason of
the empty string. Only the last of those was the route's doing: it names `usage`
and `tool_calls` in its own output schema and takes `tools` as a parameter, and
none of the three was asked for or read. The reply was read for its text alone,
so tool calling was unreachable at both ends.

Moving to the OpenAI-compatible route (above) lets the reply be carried whole
rather than read a field at a time, which is what stops a field being lost for not
having been named. `tools`, `tool_choice`, `stream_options` and the usual OpenAI
sampling parameters are now sent. Cloudflare documents that route by example
rather than by parameter list, so what is sent is what an OpenAI-shaped route is
expected to take — on the footing that a parameter it ignores is no worse than
one never sent, which is an assumption rather than something its documentation
settles.

The older reply shape is still read, for a custom host mapping this path onto the
route it came from, and now for everything that shape carries rather than the text
alone. What that route has no way to report is the reason for stopping, so a turn
answered through it that asked for a tool says so, and one that did not says
nothing — the same empty string as before.

Text completions reach Cerebras, Hyperbolic, SambaNova and nScale.
`/v1/completions` was already served, but a provider is only routed there if it
names a `complete` config, and these four did not, so a request to them was
refused with `complete is not supported by <provider>` however faithfully they
served the endpoint themselves.

Which four was the work. Of the fifteen providers built on the shared
OpenAI-compatible base without `complete`, these are the ones whose own
documentation describes a text-completion endpoint reachable the way this gateway
reaches it. Groq lists text completions among the OpenAI endpoints it does not
serve. Upstage, Kluster, Krutrim, Lemonfox, IO Intelligence and AI Badgr describe
none. DashScope describes one, but only on its mainland hosts, where this
provider is pointed at the international one; Inference.net refers to one without
documenting how to call it. None of them are added on the strength of being
OpenAI-shaped, and a test records each omission so that reversing it is a
decision with a source behind it. Vertex AI resolves its own config per backend
and is not this kind of provider, and z-ai is registered without being a valid
provider, so nothing reaches it either way.

This is the shared-base family only. Around forty other registered providers
still name no `complete`, some of which — DeepInfra and SiliconFlow among them —
do serve one.

The parameters each accepts are its own, and are taken from what each publishes
for completions rather than from what it publishes for chat. The two differ:
Cerebras excludes `logprobs` from chat and takes it here, up to 20 where the
shared default stops at 5; SambaNova is the other way round, and takes the
`logit_bias` and `seed` its chat config leaves out; nScale takes `seed` too.
Hyperbolic publishes no list, so nothing is excluded — dropping a parameter it
accepts would lose it silently, where forwarding one it does not lets it say so
itself.

SambaNova separates its events with a single newline, so its streamed
completions are re-framed as SSE on the way out. Handed on as they arrived they
would have reached the caller as a body no event parser will read.

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

- A reasoning effort sent to Gemini was named in a way the model refuses, unless
  the model said `gemini-2.5` in so many words. Gemini takes the effort as a token
  budget or as a level, and which one depends on the version: 2.5 answers a level
  with an error, while 3 reads a level and still takes a budget for
  compatibility. Only 2.5 was matched, so everything else — an earlier Gemini, or
  one of the `latest` aliases, which name no version — was sent a level, and got
  back a 400. A model that cannot be placed now gets a budget, that being the
  guess Gemini 3 tolerates rather than the one 2.5 refuses.

  Two more ways the effort was not what was asked for:

  - `none` said nothing at all, leaving a model that reasons by default reasoning.
    It is now a budget of zero for the 2.5 Flash models, which is how they are
    told to stop. It remains nothing for 2.5 Pro and for Gemini 3, which Google
    says cannot be stopped, and for anything unplaceable — a zero they refuse is
    no better than the silence.
  - An effort given as a number of tokens, which the parameter allows, fell to
    the medium budget. The number asked for was replaced by another without a
    word. Gemini 3 has no level for a number, so there it is sent as the budget
    it still accepts.

  A request carrying both a thinking block and an effort wrote each under its own
  name, leaving two thinking configs where Gemini refuses more than one. An
  effort the model can act on now replaces the block; one it cannot leaves the
  block where it is. The mapping itself was written out twice, once for Google
  and once for Vertex, and is now written once so the two cannot drift apart —
  though the generation config around it is still two copies.

- Hooks and guardrails were accepted in silence. `before_request_hooks`,
  `after_request_hooks`, `input_guardrails` and `output_guardrails` were
  validated and counted as enough to make a config valid on their own, and
  `default_input_guardrails` and `default_output_guardrails` were overwritten by
  the headers of the same name before anything could read them — and then all of
  it was dropped without a word, none of it being implemented. Someone who sets
  `output_guardrails` believes what the model says is being screened before it
  reaches anyone, and nothing about the answer they got back said otherwise. They
  are named in the same warning `retry` and `cache` already got, along with the
  `x-lightport-default-input-guardrails`, `x-lightport-default-output-guardrails`,
  `x-lightport-cache` and `x-lightport-retry-count` headers, which are read
  whether or not a config was sent and were saying nothing at all.
- A guardrail header that was not JSON failed the request as the gateway's own
  fault. It is read as JSON well past the point anything catches, so a malformed
  one raised a 500 and paged, for a header naming something nothing acts on. It
  is answered as the caller's mistake now, the way a malformed config always was.
- A default model one provider named was sent by all of them. The shared
  OpenAI-compatible base copies its parameters one level deep, so each was still
  the very object OpenAI's own config holds, and writing a default into it wrote
  that default everywhere. Whichever provider named one last won: a request that
  named no model was sent `glm-4.6` — Zhipu's — whether it was bound for Groq,
  Cerebras, Nebius, SambaNova, x-ai or OpenAI itself. Each now keeps what it
  chose, and the providers that chose nothing keep OpenAI's. The model is the
  only parameter this reached: a default is only filled in for one the provider
  requires, and the model is the one that is. Had it reached the others, no
  provider names a `max_tokens`, `temperature` or `top_p` today for it to have
  leaked. The same mistake sits unexercised in the Anthropic base, where nothing
  names a default yet, and is corrected there too.
- The name an assumed AWS role was given named a day that was not the day. The
  month was counted from zero and neither part was padded, so a call made on the
  25th of November was recorded as `20261025` — eight digits, well formed, and a
  month early — while the earlier months ran their digits together into something
  that was not a date at all. The name is written into CloudTrail and into the
  cost report against every Bedrock and SageMaker call made with the role, where
  a date that merely looks right is worse than one that obviously is not. It is
  now the day it was made on. Nothing else changes: the name is no part of what
  the credentials are cached under, and STS took the old one as readily as the
  new.
- A failed text completion reached the caller as the provider had written it.
  The shared transform for that endpoint built the named and reshaped error and
  then dropped it, where the one for chat returns it, so the same failure read
  differently depending on which endpoint it came from.
- Bedrock reported a usage object whose parts did not sum to its total. Bedrock
  documents `inputTokens` as the non-cached input alone, the whole input being
  `inputTokens + cacheReadInputTokens + cacheWriteInputTokens`, but does not say
  which of those two its own `totalTokens` sums. Reporting the whole input as
  `prompt_tokens` while passing that total through unchanged left the two
  disagreeing whenever the cache was used. The total is now derived from the two
  counts beside it, in the streamed response as well as the whole one, which
  holds whichever of the two Bedrock meant.
