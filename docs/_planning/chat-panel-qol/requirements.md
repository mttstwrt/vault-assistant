# Requirements: chat panel quality-of-life

**Status:** Draft for review · **Date:** 2026-08-30

Three changes to the chat panel header, taken together because they share it:
drop the effort selector, add a context-usage ring, and add a model selector.

## 1. Why now

The panel header currently offers one control — the reasoning-effort selector —
and it is the one that works least well. It offers levels a model may not have,
because nothing in the OpenAI schema enumerates the values `reasoning_effort`
accepts and llama.cpp advertises none: it hands the value to the model's Jinja
chat template and lets the template decide. The levels the panel shows are
guessed by reading that template, and a guess is what they stay.

Meanwhile the two things the panel never shows are the two the primary endpoint
does report: how full the context window is, and which model is answering.
llama.cpp's own web UI shows both, and the plumbing to serve them here already
exists — `GET /props` is already called (for the effort guess), and
`GET /v1/models` is already called (by the settings tab's model picker).

## 2. The primary endpoint

llama.cpp is the endpoint this plugin is developed and tested against. Where a
behaviour cannot be good everywhere, it is made good there first, and merely
correct elsewhere: an endpoint that reports nothing gets a control that says so
rather than one that lies. Every design decision below is anchored to a specific
place in llama.cpp's server or web UI, cited by path, so the behaviour can be
checked against the reference rather than argued about.

Reference points used throughout (`ggml-org/llama.cpp`, master as of 2026-08-30):

| What | Where |
| --- | --- |
| `/props` response, incl. `default_generation_settings.n_ctx` | `tools/server/server-context.cpp` (`get_res_props`), documented in `tools/server/README.md` § **GET `/props`** |
| Router `/props` and `/props?model=<id>&autoload=false` | `tools/server/server-models.cpp` (`get_router_props`, `is_autoload`) |
| `/v1/models` in router mode, incl. per-model `status` | `tools/server/server-models.cpp` (`get_router_models`) |
| `timings` fields and the context-usage formula | `tools/server/server-common.cpp` (`server_slot_stats::to_json`), documented in `tools/server/README.md` § *Timings and context usage* |
| Context gauge: geometry, thresholds, what it counts | `tools/ui/src/lib/components/app/chat/ChatForm/ChatFormContextGauge/`, `tools/ui/src/lib/stores/chat/context-stats.svelte.ts` |
| Model selector behaviour | `tools/ui/src/lib/components/app/models/`, `tools/ui/src/lib/stores/models/` |

## 3. Goals

**QOL-1 — Remove the effort selector.** The control, the setting behind it, the
`reasoning_effort` request field and the chat-template heuristic that fed it all
go. The README says why, and says what would have to be true for it to come
back: an endpoint that actually advertises the effort levels a model accepts, to
build against and test with. Until then, anyone who needs the parameter sends it
through **Send extra request parameters**, which already reaches the wire
untouched.

**QOL-2 — Context usage ring.** A small ring in the header showing how much of
the model's context window the conversation is using, filling and changing
colour as it grows, in the shape llama.cpp's web UI and Claude's own interface
use. Hovering gives the numbers. An endpoint that doesn't report a context size
gets an empty ring that says the size is unknown, not a wrong one.

**QOL-3 — Model selector.** A dropdown in the header listing the models the
endpoint advertises, with the configured model selected. Picking one changes the
model for the next message and persists it, so the panel and the settings tab
never disagree. With a single-model server it still earns its place by naming
the model that is answering.

## 4. Non-goals

- No model *management*: the panel never loads, unloads, or downloads a model.
  llama.cpp's router loads on demand when a request names a model, which is
  enough; `POST /models/load` stays unused.
- No live KV-cache polling (`/slots`, `/metrics`) for the ring. The numbers the
  last completion already reported are what it counts, which is what llama.cpp's
  own gauge counts.
- No context-usage *breakdown* popup (per-turn vs cumulative, cache hits,
  speeds). The per-answer stats line already carries that detail.
- No auto-compaction, trimming, or warning modal when the context fills. The
  ring reports; it does not act.
- No change to the permissions model, the agent loop's shape, workflows, or
  conversation storage.

## 5. Acceptance

Against a local llama.cpp server (`llama-server -m … --jinja`):

1. The panel header has no effort selector, and nothing in the request body
   carries `reasoning_effort` unless it was put there through extra parameters.
2. A fresh conversation shows an empty ring; after one answer the ring is
   partly filled and its tooltip reads e.g. `3,120 / 32,768 tokens · 10% used`;
   the numbers track `prompt_n + cache_n + predicted_n` from the same turn's
   `timings`.
3. Past 80% the ring turns amber, past 95% red.
4. Turning **Stream responses** off does not stop the ring from updating.
5. The model dropdown lists what `GET /v1/models` returns; picking a different
   model changes what the next message is sent to, survives a reload, and is
   reflected in the settings tab.
6. Against an endpoint with no `/props` (Ollama, OpenAI), the ring is empty and
   its tooltip says the context size is unknown; nothing errors, and the model
   dropdown still works.

`npm run lint` and `npm run build` pass.

---

Design: [design.md](design.md) · Repository README: [../../../README.md](../../../README.md)
