# The endpoint

**Responsibility.** Everything spoken to an OpenAI-compatible server: chat
(buffered and streamed), embeddings, model discovery, and the context and
sampler facts only llama.cpp volunteers.

**Not its responsibility.** What to say, which tools exist, or what a reply
means. It shapes a request, decodes a reply, and reports what the endpoint
claimed.

## Public interface

- `chatCompletion(settings, messages, tools, overrides)` — `api/client.ts`.
- `streamChatCompletion(settings, messages, tools, overrides, handlers, signal)`
  — `api/stream.ts`. Returns what arrived with `aborted: true` rather than
  throwing when the signal fires: a partial answer is kept.
- `embed(settings, texts)` — `api/client.ts`.
- `listModels(baseUrl, apiKey)` / `filterModels` / `modelOptionLabel` —
  `api/models.ts`.
- `serverDefaults(baseUrl, apiKey, model)` / `serverContextSize(...)` /
  `servesLlamaCppProps(...)` — `api/props.ts`.

**Dependents:** the agent loop, the semantic indexer, the pre-pass, the
conversation namer, the chat panel's header, and the settings tab.

## What is assumed, and what degrades

Only `POST /chat/completions` is required. Everything else is an improvement
that is allowed to be absent, and each absence has a defined behaviour rather
than an error:

| Endpoint | Gives | When absent |
| --- | --- | --- |
| `GET /models` | The model dropdowns | The model name stays a text field |
| `GET /props` | Context window, sampler defaults, the llama.cpp fingerprint | The ring says the size is unknown; blank sampler fields say only whose choice they are |
| `usage` / `timings` | Tokens, speed, the context ring | No footer, no ring fill |
| SSE streaming | Live answers, Stop | One buffered request instead, automatically |

**Nothing is invented to fill a gap.** There is no standard way to learn a
model's context window, so an endpoint that will not say leaves the ring empty
rather than showing a plausible number. The same rule killed a
`reasoning_effort` selector that inferred its options from a chat template: a
template can name a level in a branch that does nothing, accept one it ignores,
or handle one it never spells out. Offering levels a model may not have is worse
than offering none.

## The rule about request bodies

**A parameter the user did not ask for never goes on the wire.** Hosted APIs
reject fields they do not recognise, so every sampler is unset by default and an
unset one is omitted entirely — which is also what lets the endpoint's own
setting stand, instead of being overruled by a number the plugin picked.
Precedence runs settings < extra params < per-call overrides: the more specific
the source, the later it is applied. `model`, `messages`, `tools`, `tool_choice`
and `stream` cannot be clobbered by the extra-params passthrough.

llama.cpp extras are the exception that proves it. `timings_per_token` — which
makes the context ring and the speed readout move *during* an answer rather than
once per turn — is sent only to an endpoint that has identified itself by
answering `/props`. Nothing else serves that endpoint, so answering it is a
reliable fingerprint, and the lookup was already being made for the context
window.

## Reasoning

Endpoints expose a model's thinking two ways: a separate `reasoning_content`
field (llama.cpp with a reasoning format, OpenRouter, DeepSeek), or inline in
the content wrapped in `<think>` tags. A server-provided channel wins; otherwise
`api/reasoning.ts` splits the tags incrementally, so a tag arriving split across
two stream chunks is still recognised — including the case where the whole turn
was reasoning and the closing tag arrives with no opener, which reclassifies
what was already shown.

Reasoning is shown and recorded. It is never sent back.

## Loopback while offline

Obsidian is Electron, and Chromium refuses every request while the OS reports no
network — including requests to `127.0.0.1`, where the internet is irrelevant. A
model server on the same machine should not care whether you are online, so a
request to a loopback address that fails that way is retried over a direct
socket. Desktop only; remote endpoints keep Obsidian's own request path, with
its proxy and certificate handling, and genuinely do need a network.

---

Docs index: [../README.md](../README.md) · [architecture.md](../architecture.md) · [agent/](../agent/README.md) · [retrieval/](../retrieval/README.md)
