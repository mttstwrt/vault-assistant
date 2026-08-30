# Design: chat panel quality-of-life

**Status:** Draft for review · **Date:** 2026-08-30 ·
Requirements: [requirements.md](requirements.md)

## 0. Summary

| | |
| --- | --- |
| **Approach** | Delete the effort selector and the chat-template heuristic behind it. Repurpose the `/props` client it leaves behind to read `default_generation_settings.n_ctx`, and feed it plus the token counts the endpoint already reports into an SVG ring in the header, copied in geometry and thresholds from llama.cpp's `ContextGaugeDial`. Fill the space the effort selector vacated with a model dropdown driven by the `GET /v1/models` client the settings tab already uses. |
| **Alternatives** | Per section below — the significant ones are keeping a narrowed effort heuristic (§1), reading `n_ctx` from `/v1/models` instead of `/props` (§2.1), counting tokens by client-side estimation or `/slots` polling (§2.2), and building llama.cpp's hover popup rather than a tooltip (§2.4). |
| **Impact** | Nine files touched, one net new (`src/ui/context-ring.ts`); `src/api/props.ts` is rewritten around a different field of the same endpoint. One settings field and one `CallOverrides` field are removed. No storage format, permission, or tool-surface change; nothing in the agent loop's control flow changes, only what it reports. |
| **Assumptions** | Stated per section and collected in §6, with what happens if each is wrong. The load-bearing one: llama.cpp reports `timings` on every completion and `default_generation_settings.n_ctx` on `/props`, both of which are documented, and neither of which any other endpoint is required to provide. |

The three parts are independent and ship in the order below. Each is separately
verifiable against a running llama.cpp.

## 1. QOL-1 — Remove the effort selector

### What goes

| File | Change |
| --- | --- |
| `src/settings.ts` | Delete `ReasoningEffort`, `effortLabel`, the `reasoningEffort` field and its default. `save()` clears the props cache instead of the effort cache (§2.1). |
| `src/api/props.ts` | Delete `EFFORT_LEVELS`, `effortLevelsInTemplate`, `serverEffortLevels`, `clearEffortCache`. The module is rewritten in §2.1; the file survives, the effort logic does not. |
| `src/api/request.ts` | Delete `CallOverrides.reasoningEffort` and the `body.reasoning_effort` line. |
| `src/ui/chat-view.ts` | Delete `effortEl`, `renderEffortOptions`, the header `<select>`, its change handler and the `serverEffortLevels` lookup. |
| `styles.css` | Delete `.va-effort`. |
| `README.md` | Rewrite the effort sentence in **Features**, replace troubleshooting item 1, and replace *Where the effort levels come from* with the future-work note below. |

Nothing else reads any of it: `CallOverrides.reasoningEffort` has no caller —
workflow steps set `temperature` and `model` only — so this orphans no code
path. A `reasoningEffort` value already saved in `data.json` is carried along by
`Object.assign` and re-saved, unread; that is harmless and not worth a migration.

### Why, and why not the smaller change

The list of levels was never observed, it was inferred: `/props` returns the
model's Jinja chat template, and the panel searched it for quoted level names,
offering what it found when it found at least two. A template can name a level
in a branch that does nothing, can accept a level it silently ignores, and can
handle a level it never spells out. There is no endpoint available to test
against that would say which of those happened, because there is no endpoint
that advertises the answer — that is the whole problem, and it is not one more
heuristic away from being solved.

- **Narrow the heuristic** (parse the template's control flow rather than
  grepping it) — rejected: a better guess is still a guess, and it cannot be
  validated without the thing whose absence is the problem.
- **Keep the setting, hide the control** — rejected: a setting no UI reaches is
  a permanent maintenance surface with no user (principle 2), and the escape
  hatch below already covers the need.
- **Move it to the settings tab** — rejected: same wrong list, further from the
  conversation it applies to.

### The escape hatch, and the note

`reasoning_effort` is not in `PROTECTED_BODY_KEYS`, so **Send extra request
parameters** with `{"reasoning_effort": "low"}` puts it on the wire exactly as
the selector did. Removing the control removes the guessing, not the capability.

The README note (troubleshooting, where the selector is referenced today) says:
effort selection is future work; it needs an endpoint that advertises the levels
a model accepts, since the OpenAI schema does not enumerate them and llama.cpp
passes the value into the chat template without claiming anything about it; it
should be built and tested against such an endpoint rather than inferred; and
until then the parameter goes through extra request parameters.

## 2. QOL-2 — Context usage ring

llama.cpp's gauge is three things: a denominator from `/props`, a numerator from
the last completion's `timings`, and a dial. Each is taken in turn.

### 2.1 The denominator: `n_ctx` from `/props`

`GET /props` returns `default_generation_settings.n_ctx`
(`tools/server/server-context.cpp`, `get_res_props`), which is `meta.slot_n_ctx`
— the context of one slot, i.e. the budget for a single request, not the sum
across `--parallel`. That is the right denominator, and it is the field
llama.cpp's own UI reads (`stores/models/props.svelte.ts`,
`getModelContextSize`).

`src/api/props.ts` keeps its shape — same URL derivation (`/props` sits at the
server root, beside `/v1`), same session cache, same "any failure is a `null`,
not an error" contract — and returns a context size instead of a level list:

```ts
export function serverContextSize(baseUrl, apiKey, model): Promise<number | null>
export function clearPropsCache(): void
```

Two llama.cpp-specific details decide the request:

- **Router mode.** `/props` with no `model` parameter answers for the router
  itself: `role: "router"`, `model_path: "none"`, and `n_ctx: 0` — a deliberate
  dummy so a UI does not break (`server-models.cpp`, `get_router_props`). So the
  request passes `?model=<id>`, URL-encoded, as the README's router section
  shows. A single-model server ignores the parameter, so one request shape
  works for both, and `n_ctx: 0` is read as *unknown*, never as zero.
- **`autoload=false`.** In router mode a bare `/props?model=…` will *load* the
  model to answer (`is_autoload` defaults to the server's `--models-autoload`).
  Asking how big a context is must not spend thirty seconds loading weights, so
  the request pins `autoload=false`, exactly as `PropsService.fetchForModel`
  does in the reference UI.

The cache key becomes `(props URL, model)` rather than the props URL alone,
because in router mode the answer differs per model. The settings tab's `save()`
clears it — the same hook that clears the effort cache today.

*Alternative rejected:* read `meta.n_ctx` from `/v1/models`, which would serve
the ring and the dropdown from one request. It is there in current builds, but
it is absent from the documented response in `tools/server/README.md`, and in
router mode it only appears for models that are already loaded (it arrives via
the child's `loaded_info`). `/props` is the documented, always-answerable
source, and it is the one the reference UI treats as authoritative.

### 2.2 The numerator: what the last turn cost

llama.cpp's README states the formula outright: *the total number of tokens in
context is equal to `prompt_n + cache_n + predicted_n`*, where `prompt_n` is the
prompt tokens actually processed and `cache_n` the prompt prefix reused from
cache (`server-common.cpp`, `server_slot_stats::to_json`). Its UI computes the
same thing —  `contextUsed = currentRead + currentOutput`, with `currentRead =
prompt_n + cache_n` of the **last** assistant turn
(`stores/chat/context-stats.svelte.ts`).

Last turn, not a sum over the conversation: each request re-sends the whole
history, so the newest completion's prompt *is* the conversation's footprint.
For this plugin that means the last model call of the agent loop — the one with
the fullest history — which is also what makes the ring useful, since it grows
as tool results pile into context within a single message.

Two fixes are needed before `toStats()` can report that:

1. **`cache_n` is not read.** `ApiTimings` has `prompt_n` but not `cache_n`, and
   `toStats` falls back to `promptTokens: usage?.prompt_tokens ?? timings?.prompt_n`.
   On every turn after the first the cache is warm, so `prompt_n` is a handful of
   tokens and `prompt_tokens` is thousands — the fallback undercounts by the
   entire reused prefix. Add `cache_n` to `ApiTimings` and make the fallback
   `prompt_n + cache_n`. (`usage.prompt_tokens` is already the full prompt, so it
   stays the preferred source where it exists.)
2. **Streaming has no `usage`.** llama.cpp only emits a `usage` chunk when the
   request sets `stream_options: {include_usage: true}` (`server-task.h`,
   `include_usage` defaults false), but it attaches `timings` to the final chunk
   unconditionally (`server-task.cpp`). So the streaming path depends on fix 1
   and needs no change to the request body — which is the point: an endpoint
   that does not know `stream_options` never sees it.

*Alternatives rejected:* counting tokens client-side (a tokenizer, or
characters÷4) — an estimate that disagrees with the server is worse than no
number, and `POST /tokenize` per keystroke is a request per keystroke. Polling
`/slots` or `/metrics` for live KV occupancy — more accurate mid-generation,
but it is a second endpoint, often disabled, single-model only, and it reports
the server's state rather than this conversation's.

### 2.3 Getting the numbers to the panel

`CallStats` reaches the view only through `stream.onDone`, so with **Stream
responses** off it is dropped on the floor. Add to `AgentEvents`:

```ts
/** What the endpoint reported about one model turn, streamed or buffered. */
onStats?(stats: CallStats): void;
```

called from `runAgent` after every model turn on both paths. The panel keeps the
most recent one and redraws the ring. `stream.onDone` keeps its own `stats` for
the per-answer footer; the two are the same numbers reported to different
places, and merging them would mean the footer's per-turn line and the ring's
whole-conversation reading fight over one channel.

*Alternative rejected:* have the panel read the last `AssistantTurn`'s stats — a
tool-only turn has no bubble to read, and the buffered path has no turn at all.

The ring resets when the conversation does (**New chat**, opening a saved
conversation): a reopened transcript carries no token counts, and showing the
previous conversation's fill would be a lie about this one.

Two things deliberately do not move it. The context pre-pass and the
conversation-naming call reach `chatCompletion` directly rather than through
`runAgent`, so they never report here — which is what we want, since a
two-hundred-token title call is not this conversation's context footprint and
would make the ring appear to shrink. Workflow runs do go through `runAgent`,
but the runner builds its own events and will not set `onStats`, so a run leaves
the ring showing the chat's own numbers; wiring it up there is a follow-up if it
turns out to be wanted.

### 2.4 The dial

New module `src/ui/context-ring.ts`, mounted at the right-hand end of the
header — `[title] [icon buttons] [model ▾] [ring]`, so the two readouts sit
together and the buttons keep their order. Geometry is copied from
`ContextGaugeDial.svelte`: a 32×32 `viewBox`, two concentric circles at `r=11`,
the track at `stroke-opacity: 0.1`, the progress arc with
`stroke-dasharray = 2πr` and `stroke-dashoffset = C · (1 − percent/100)`,
`stroke-linecap="round"`, `transform="rotate(-90 16 16)"` so it starts at twelve
o'clock, rendered at 3px stroke in a 20px box.

Thresholds from `context-gauge.ts`: under 80% normal, 80–95% warning, 95%+
critical. The colours are Obsidian's theme variables — `--text-muted`,
`var(--text-warning, var(--color-orange))`, `--text-error` — rather than the
reference's Tailwind literals, so the ring follows the user's theme like the
rest of the panel.

It advances a turn at a time, when a completion reports its numbers, rather than
counting up during generation the way the reference UI's live processing state
does. A long prompt therefore shows last turn's fill until the answer lands.
Live counting would mean reading the growing prompt before the server has
weighed it, which is the client-side estimate rejected in §2.2.

The tooltip is the `title` attribute — `12,431 / 32,768 tokens · 38% used`, or
`12,431 tokens · context size unknown` when `/props` said nothing, or
`Context usage — no answers yet` on a fresh conversation.

*Alternative rejected:* llama.cpp's hover card, with its per-turn and cumulative
breakdown, cache totals and speeds. It is a popup, an outside-click handler, a
detail grid and a monitoring hook — a lot of surface for a sidebar this narrow,
and the per-answer stats line under each answer already reports the same
figures for the turn that produced them. If the tooltip proves too thin in use,
the card is the obvious next step and nothing here forecloses it.

## 3. QOL-3 — Model selector

A `<select class="dropdown va-model">` in the header, in the space the effort
selector vacates (which is why QOL-1 ships first), listing what
`GET /v1/models` advertises, filtered by the existing `filterModels(…, 'chat')`
and labelled by the existing `modelLabel` (which strips the directory and the
`.gguf` suffix llama.cpp reports as an id). Choosing one writes
`settings.model`, saves, and re-reads `/props` for the new model's `n_ctx`.

Details that follow from the reference implementation and from what is already
here:

- **The configured model is always an option**, even when the endpoint does not
  list it — the same rule the settings tab's picker follows, so picking from the
  list is never a one-way door out of a hand-typed name.
- **Shown even with one model.** llama.cpp's UI names the active model in every
  mode, and the panel currently never says which model is answering. A
  one-entry dropdown is a label that happens to be selectable.
- **Disabled while busy**, like the reference UI's selector during streaming:
  swapping models between tool rounds of one message would silently split an
  answer across two models.
- **Loaded-state marker in router mode.** `GET /v1/models` on a router returns
  `status.value` per model — `loaded`, `sleeping`, `loading`, `unloaded`,
  `downloading`, `downloaded`, plus a separate `failed` flag
  (`server-models.h`, `server_model_status_to_string`; `server-models.cpp`,
  `get_router_models`) — in the same response the list comes from. `sleeping`
  counts as loaded, as it does in the reference UI: the weights are still
  resident, the server has only idled the context. Picking an unloaded model means the next message waits for weights
  to load, so the label carries the state (`Qwen3-30B · loaded`). This is the
  one place the plan adds beyond the minimum: it costs `listModels` returning
  `{ id, status? }[]` instead of `string[]`, and a two-line adaptation in the
  settings tab. Worth it because router mode is the setup where a dropdown
  earns its place at all, and it is free of extra requests — but it is cleanly
  severable if you would rather not pay the type change.
- **When the list comes.** `listModels` gains a module-level session cache keyed
  by endpoint (the panel would otherwise re-request on every open), cleared by
  the settings tab's `save()` alongside the props cache. The settings tab keeps
  its own discovery state and its refresh button; folding the two together is a
  worthwhile cleanup but not this change.
- **When discovery fails** (no `/models`, no network, an error status), the
  dropdown holds the configured model alone and the failure stays in the
  console, as it does today. The settings tab is where discovery failures are
  explained; the header is not the place for an error message.

## 4. What this touches

| File | QOL | Change |
| --- | --- | --- |
| `src/settings.ts` | 1, 2, 3 | Remove effort type/label/setting; `save()` clears the props and model caches; picker adapts to richer model entries. |
| `src/api/props.ts` | 1, 2 | Rewritten: context size instead of effort levels; per-`(url, model)` cache; `autoload=false`. |
| `src/api/models.ts` | 3 | Entries carry `status`; session cache; `clearModelCache()`. |
| `src/api/request.ts` | 1, 2 | Drop `reasoning_effort` and its override; add `cache_n` to `ApiTimings`; fix `toStats`. |
| `src/agent.ts` | 2 | `onStats` on `AgentEvents`, reported on both call paths. |
| `src/ui/chat-view.ts` | 1, 2, 3 | Effort selector out; ring and model dropdown in; ring reset on conversation change. |
| `src/ui/context-ring.ts` | 2 | New. The dial, its colours and its tooltip. |
| `styles.css` | 1, 2, 3 | `.va-effort` out; `.va-model` and `.va-ring` in. |
| `README.md` | 1, 2, 3 | Effort note rewritten as future work; ring and dropdown documented in **Features** and **Settings**. |

**What could break.** The agent loop gains one optional callback and the request
body loses one optional field — neither changes what the model sees, except that
`reasoning_effort` is no longer sent, which is the point. The header gains two
controls: it already wraps (`flex-wrap`), and the model select needs the same
`max-width` and ellipsis the effort select had, or a long GGUF name will push
the icon buttons onto a second row in a narrow sidebar. Everything added is DOM
plus one HTTP request, so mobile is unaffected.

**What depends on it.** Workflows pass `overrides.model` per step, so a step
that pins a model is untouched by the dropdown; a step that does not will pick
up the panel's model on its next call, which is the existing behaviour of the
settings field the dropdown writes to.

## 5. Order and verification

1. **QOL-1**, which is deletion plus a README note, and frees the header space.
2. **QOL-2**: `n_ctx` lookup, then the `toStats` fix, then `onStats`, then the ring.
3. **QOL-3**: the dropdown, last because it is the only part that changes a
   shared signature.

Verified against a local `llama-server`, per the acceptance list in the
requirements: `npm run lint`, `npm run build`, then a real conversation — ring
empty, ring filling, ring amber past 80%, streaming off and the ring still
moving, the dropdown listing and switching models, and `{"reasoning_effort":
"none"}` in extra parameters still reaching the wire. Router mode is designed
for and cited from source, but cannot be tested here unless a router is running;
if it is not, the plan says so rather than claiming otherwise.

## 6. Assumptions

| Assumption | If it is wrong |
| --- | --- |
| llama.cpp serves `/props` with `default_generation_settings.n_ctx`. Documented for years and unchanged on master. | The ring shows an unknown context size — the same state as any non-llama.cpp endpoint. Nothing errors. |
| `timings` (with `cache_n`) is on every completion, streamed or buffered. Emitted unconditionally when slot stats are set. | With `cache_n` missing the ring reads low but stays monotonic and never breaks; with no `timings` at all it stays empty. |
| The last model call's prompt is the conversation's context footprint. | It is a lower bound if the server trims or shifts context itself; the reference UI makes the same assumption. |
| The target setup is a single `llama-server`, with router mode supported but secondary. | Router paths (`?model=`, `autoload=false`, the loaded marker) are the only untested ones, and each degrades to the single-model behaviour. |
| No endpoint the user can test advertises reasoning-effort levels. | If one appears, the README note names exactly what to build against, and the extra-parameters passthrough covers the gap meanwhile. |

---

Requirements: [requirements.md](requirements.md) · Repository README: [../../../README.md](../../../README.md)
