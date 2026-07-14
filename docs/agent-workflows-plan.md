# Plan: Agent workflows, sampler control, context pre-pass, and life-tracker integration

**Status:** Approved · **Date:** 2026-07-13

Companion doc: `obsidian-event-tracker/docs/overview-and-agent-integration-plan.md` (the life-tracker side).

## 1. Goals

1. **Declarative agent workflows** — replace the hard-coded research mode with user-editable workflow definitions, stored as notes in the vault, executed by a small runner on top of the existing `runAgent` loop.
2. **Per-step sampling control** — temperature (and model) per workflow step, plus a raw passthrough for llama.cpp's server-side dynamic samplers.
3. **Context pre-pass** — an opt-in "prepare context before answering" pass tuned for small local models (the user runs Qwen 3.6 27B Q4_K on llama.cpp).
4. **Life-tracker integration** — consume the life-tracker's in-process runtime API as agent tools, then build a *life coach* workflow preset on top.

## 2. Decisions already made

| Question | Decision |
| --- | --- |
| LangGraph? | **No.** `agent.ts` is ~100 lines and sufficient; LangGraph is a heavy dep that violates the "small, mobile-safe" constraint. A declarative schema + small runner covers the need. |
| Visual workflow editor? | **Viewer shipped, editor not now.** The picker previews steps inline, and "View workflow as canvas" exports a read-only `.canvas` (JSON Canvas) next to the workflow notes. Parsing canvases *as* workflow definitions (the editor direction) remains optional/last. |
| External MCP clients (Claude Desktop/Code)? | **Out of scope.** No standalone stdio MCP server. Integration is in-process only. |
| Token-level dynamic temperature? | **Not buildable client-side** (sampling is server-side, per-request). Instead: passthrough of extra body params so llama.cpp's `dynatemp_range` / `dynatemp_exponent` / mirostat can be enabled. Behind a toggle. |
| Research mode's fate | Becomes the first built-in workflow preset. Existing research UI stays as a shortcut that launches it. |

## 3. Non-goals

- No new runtime dependencies (no LangGraph, no workflow engine, no YAML lib beyond what's already used).
- No changes to the permissions model — workflows *reference* the existing approval flow (`ask` / `deny`), they don't extend it.
- No streaming, no parallel step execution. Steps run sequentially; conditions are simple.
- No standalone MCP server package.

## 4. VA-1 — Sampler passthrough (llama.cpp)

*Smallest task; ships first.*

- Settings: toggle **"Send extra request parameters"** + a JSON textarea (`extraBodyParams`), default off, prefilled example:
  `{"dynatemp_range": 0.4, "dynatemp_exponent": 1.0}`
- `api/client.ts:chatCompletion` merges the parsed object into the request body when the toggle is on. Invalid JSON → setting is ignored with a console warning (never blocks a chat).
- Doc note in README: works with llama.cpp's OpenAI-compatible server (which accepts extra sampling params); Ollama's OpenAI route ignores them.

## 5. VA-2 — Declarative agent workflows

### 5.1 Storage

Workflows are markdown notes in a new always-writable folder (default `AI/Workflows`, setting `workflowsFolder`). Frontmatter defines the workflow; the body is human documentation. Being vault notes, workflows are greppable, syncable, and creatable/editable by the agent itself.

### 5.2 Schema (frontmatter)

```yaml
name: Deep research
description: Autonomous multi-round research toward a goal.
loop: true            # repeat the step list until finished/stopped/budget
defaultRounds: 5      # suggested rounds budget (0 = until stopped)
defaultDelaySeconds: 0
steps:
  - id: work
    prompt: |
      (system-prompt suffix for this step — what to do this round)
    temperature: 0.8   # optional; falls back to global setting
    tools: all         # or an allowlist: [read_file, search, update_wiki]
    approvals: deny    # deny = autonomous (auto-deny out-of-scope writes); ask = interactive
    maxSteps: 0        # optional cap on tool rounds; 0 = global setting
```

- `loop: true` + a single step reproduces today's research mode exactly. Multi-step workflows run steps in order each round; each step is one bounded `runAgent` conversation.
- A workflow **run note** (in the existing research folder, renamed conceptually to "runs") accumulates the goal and each step/round report — same note-as-memory mechanics as `research.ts` today: restart-safe, resumable, context-bounded.
- `finish_research` generalizes to `finish_run` (kept as an alias in the prompt for compatibility).

### 5.3 Runner

`src/workflows/` — `schema.ts` (parse/validate frontmatter), `presets.ts` (built-in workflow bodies), `runner.ts` (generalizes `ResearchRun`: per-step system-prompt suffix, temperature/model/tool-allowlist overrides, approvals policy). `research.ts` becomes a thin wrapper that launches the *Deep research* preset, so the existing modal/telescope UI keeps working.

### 5.4 Per-call overrides

`chatCompletion` gains an optional `overrides?: { temperature?: number; model?: string }` argument; `runAgent` threads it through via `AgentOptions`. This is the whole of "dynamic temperature adjustment based on task" at the granularity that matters.

### 5.5 Presets

Shipped in code; a command **"Create workflow preset"** writes the chosen preset into `AI/Workflows/` where the user can edit it:

- **Deep research** — the current research behavior, verbatim.
- **Wiki gardener** — sweep the wiki for orphans/broken links/thin pages; fix and interlink. Low temperature.
- **Weekly review** — read the week's daily notes + conversations, write a review note with themes and loose ends.
- **Life coach** — added in VA-5 (needs the life-tracker tools).

### 5.6 UI

The research modal becomes a **workflow picker**: choose a workflow (built-ins + anything in `AI/Workflows/`), enter the goal, set rounds/delay. Resume works as today (any run note whose status ≠ done).

## 6. VA-3 — Context pre-pass

Opt-in toggle **"Prepare context before answering"** (default off). On each *new* user message in a normal chat:

1. One cheap model call (low temperature, no tools): given the user message + wiki Home outline, emit 2–4 search queries (JSON array).
2. Run each query through `semantic_search` (if enabled) and literal `search`; collect top chunks, dedupe by path.
3. Inject a bounded context block (`--- Pre-fetched context (may be irrelevant) ---`) into the system prompt for the real conversation.

Rationale: small local models flail on tool selection; pre-fetched grounding reduces tool rounds. Cost: one extra round-trip. Evaluate on ~10 fixed personal queries before defaulting on; keep the block clearly labeled as possibly irrelevant so the model isn't anchored.

## 7. VA-4 — In-process `plugin` transport for McpManager

- `McpServerConfig` gains `transport: 'stdio' | 'http' | 'plugin'` and `pluginId` (e.g. `obsidian-life-tracker`).
- `PluginTransport` implements the existing `McpTransport` request surface without JSON-RPC: `tools/list` reads the target plugin's `api.toolDescriptors`, `tools/call` invokes `api.invoke(name, args)`. Resolution via `app.plugins.plugins[pluginId]`; if the plugin is missing/disabled or `api.version` is incompatible, the server fails to connect with a clear Notice (same non-fatal path as today).
- Tools ride the existing namespacing (`mcp__lifetracker__log_event`), trust flag, and session-approval flow. Default untrusted, so writes prompt like vault writes. Works on mobile (no process).
- Ship a default (disabled) server entry for the life tracker so setup is one toggle.

Contract details (descriptor shape, tool list): see the life-tracker plan doc §4.

## 8. VA-5 — Life coach preset + scheduling

1. **Goals note** — default `AI/Goals.md` (setting), read by the workflow at run start.
2. **Preset workflow** — loop with two steps: *assess* (pull `get_summaries` + recent `query_events` via life-tracker tools, compare against goals, low temperature) and *coach* (write a coaching report: imbalance call-outs, concrete adjustments, optionally `plan_item` tomorrow's blocks; warmer temperature). Reports accumulate in the run note; durable insights go to the wiki.
3. **Scheduling** — settings: enable + interval (e.g. daily) + workflow to run. `registerInterval` while Obsidian is open; on plugin load, if `lastScheduledRun` is older than the interval, run once (catch-up). Last-run status shown in the workflow picker.

## 9. Order of work

| Step | Task | Depends on |
| --- | --- | --- |
| 1 | VA-1 sampler passthrough | — |
| 2 | VA-2 workflows + presets | — |
| 3 | VA-3 context pre-pass | — |
| 4 | VA-4 plugin transport | life-tracker LT-3 (runtime API) |
| 5 | VA-5 life coach + scheduling | VA-2, VA-4 |
