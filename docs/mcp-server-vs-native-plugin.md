# A vault MCP server vs. the vault-native plugin

A decision note on whether the tools in this plugin would be better shipped as a
standalone MCP server that any LLM client can connect to.

## The short version

The hypothesis — *"the difference is where the UI lives, not real capability"* —
is about **one third right**. It holds for most of the tool surface and breaks
down in three places:

1. **MCP is a tool protocol, not an agent runtime.** It has no answer for the
   agent loop, the pre-pass, workflows, scheduling, per-step sampling, or
   transcript capture. Going server-first doesn't remove that layer, it makes it
   somebody else's client's problem.
2. **Some tools can't be served from outside Obsidian at all** — anything that
   depends on live app state (`open_files`) or on the metadata cache's link
   resolution.
3. **llama.cpp is not an MCP client.** `llama-server` is an inference endpoint;
   it does not connect to MCP servers. "Any LLM service can connect to it" means
   *any front-end* can — so the choice is really "our Obsidian UI" vs. "a
   third-party client we adopt and configure," not "UI" vs. "no UI."

Counting lines: of ~6,000 lines in `src/`, roughly 2,000 (tools, permissions,
RAG, wiki/memory helpers) would move cleanly into a server. The other ~4,000 —
chat view, agent loop, workflow runner, pre-pass, scheduler, conversation
persistence, importer, approval UI — is the part MCP relocates rather than
replaces.

## What each side can actually provide

| Capability | MCP server | Native plugin |
| --- | --- | --- |
| `list_files`, `read_file`, `search`, `write_file`, `append_file` | ✅ clean fit | ✅ today |
| `semantic_search` + incremental index | ✅ clean fit (needs its own file watcher) | ✅ today |
| `wiki_home`, `wiki_page`, `list_wiki`, `update_wiki`, `remember` | ✅ clean fit (plain markdown conventions) | ✅ today |
| `links` / backlinks / broken links | ⚠️ must reimplement Obsidian's resolution rules (aliases, shortest-path, unresolved links) | ✅ free from `metadataCache` |
| `open_files` — which notes are open and focused | ❌ an external process cannot see Obsidian's workspace | ✅ `src/tools/workspace.ts` |
| Writes coordinated with unsaved editor buffers | ⚠️ external writes can race the open editor | ✅ `vault.modify` goes through Obsidian |
| Folder-scoped read/write permissions | ⚠️ must be re-enforced server-side; client allowlists are not a substitute | ✅ `src/permissions.ts`, in-process |
| Approval granularity (once / session / always-file / always-folder) | ⚠️ depends on the client; most offer allow/deny per tool | ✅ `src/types.ts` `ApprovalResult` |
| Agent loop, step budget, tool-result feedback | ❌ out of scope for MCP | ✅ `src/agent.ts` |
| Context pre-pass (extra cheap call before each turn) | ❌ requires owning the completion loop | ✅ `src/prepass.ts` |
| Workflows: rounds, per-step model/temperature/tool allowlist/approval policy | ❌ MCP prompts are templates, not a runner | ✅ `src/workflows/` |
| llama.cpp sampler passthrough (`dynatemp_range`, mirostat) per step | ❌ client concern; few clients expose it | ✅ `useExtraBodyParams` + `CallOverrides` |
| Transcripts saved as vault notes automatically | ⚠️ only via a tool the model must remember to call | ✅ `src/conversation.ts` |
| Mobile (iOS/Android) | ❌ no local process; remote hosting breaks the privacy story | ✅ `isDesktopOnly: false` |
| Runs while Obsidian is closed | ✅ cron/systemd | ❌ scheduler ticks only while the app is open |
| Unit-testable in CI | ✅ plain Node process | ❌ needs Obsidian; repo has no tests today |
| Reusable from Claude Code, Cursor, scripts | ✅ that's the point | ❌ tools are locked in-process |

## MCP server

**Pros**

- **Client portability.** The same vault tools from Claude Code, Cursor, Claude
  Desktop, Open WebUI, or a cron script. If you want a frontier model's harness
  for hard research and llama.cpp for private work, that's one server, N clients.
- **Borrow a better agent loop.** `runAgent` is ~105 lines with a fixed step
  budget and no compaction, retry, or sub-agent story. Claude Code's harness is
  vastly more capable and you maintain none of it.
- **Testable and CI-able.** Tool logic becomes a plain process you can unit-test.
  Right now nothing here can be tested without launching Obsidian, and there are
  no tests.
- **Runs headless.** Scheduled work doesn't depend on Obsidian being open — the
  current scheduler only ticks while the app runs (`SCHEDULE_TICK_MS` in
  `src/main.ts`).
- **Insulated from Obsidian.** No plugin-review policy, no API churn, no
  bundling constraints.
- **Smaller thing to own.** Roughly a third of the codebase, and the third with
  the least UI surface.

**Cons**

- **You still need a client, and llama.cpp isn't one.** You'd be adopting a
  third-party front-end and inheriting its MCP maturity, its sampler support, and
  its transcript storage. Worth verifying before committing.
- **You lose the orchestration layer wholesale.** Pre-pass, workflows, scheduled
  life-coach runs, per-step tool allowlists — none of that survives the move
  unless the new client happens to have equivalents. For a small local model the
  pre-pass and per-step tool pruning are not cosmetic: they're what keep tool
  selection tractable.
- **No workspace awareness.** "Summarise this note" stops working without naming
  a file. That's the feature most visibly tied to living inside the app.
- **It recreates the problem the importer solves.** Conversations would land in
  the client's own store, outside the vault — which is exactly why
  `src/import/` exists. You'd be re-importing transcripts you used to get for
  free.
- **Weaker security posture, subtly.** The permission model has to be
  reimplemented server-side and enforced there; a localhost server with vault
  write access is reachable by any process on the machine unless you add auth.
  Today `isReadable`/`isWritable` cannot be bypassed because there's no wire.
- **No mobile.**
- **Link fidelity costs real work.** Obsidian's link resolution is not just
  regex over `[[...]]`.

## Native plugin (current)

**Pros**

- **Live app state.** Open tabs, focused note, immediate writes through the vault
  API, no file-watch races. This is capability, not UI.
- **Orchestration you control end to end.** Per-step model, temperature, tool
  allowlist, approval policy, rounds, delay, resume-from-run-note. Built for
  autonomy on a local model, and none of it is expressible in MCP.
- **Tuned for small local models.** Pre-pass grounding, a curated ~13-tool
  surface, `activeToolSpecs` pruning, and llama.cpp sampler passthrough. Generic
  clients typically give you a fixed tool list and no pre-pass.
- **Conversations are notes by default** — searchable, linkable, semantically
  indexable, continuable. The stated point of the project.
- **Fine-grained, in-process permissions** that no client configuration can
  loosen.
- **Mobile works**, including the in-process `plugin` transport for Life Tracker.
- **No process management.** Nothing to install, supervise, port-allocate, or
  restart.

**Cons**

- **Tools are trapped.** Nothing else — Claude Code, a script, another editor —
  can use them.
- **You maintain an agent harness** and will keep chasing what dedicated harnesses
  do better.
- **You already maintain an MCP client** (`src/mcp/transport.ts`,
  `src/mcp/manager.ts`) — three transports, JSON-RPC, SSE parsing — which is
  server-side work you took on anyway.
- **Effectively untestable**, and no tests exist.
- **Dead while Obsidian is closed.**
- **Coupled to Obsidian's API and plugin policy.**

## The option that isn't either/or

This plugin is **already an MCP client**, with a working HTTP transport. The
symmetric move is to have the plugin **host** an MCP endpoint rather than replace
itself with one:

- On desktop, expose `list_files` / `read_file` / `search` / `semantic_search` /
  `links` / `open_files` / the wiki tools over a local HTTP MCP server inside the
  plugin (the Local REST API plugin does exactly this shape).
- External clients get the vault tools **with** metadata-cache link fidelity,
  workspace awareness, and the existing permission checks — because the tools run
  inside Obsidian, not against the folder on disk.
- The Obsidian UI, workflows, pre-pass, and transcript capture stay exactly as
  they are.
- Mobile keeps working; the endpoint is simply desktop-only, mirroring the
  existing stdio-on-desktop-only rule in `McpManager.connectAll`.

Cost is roughly a transport + a tool-dispatch shim over `executeTool`, plus a
token and loopback binding. Most of the tool code is already shaped for it:
`executeTool(ctx, name, argsJson) -> string` is one adapter away from
`tools/call`.

## Recommendation

Don't replace the plugin with a server. The parts you'd keep are the cheap parts,
and the parts MCP can't carry — orchestration, workspace awareness, transcripts
in the vault, small-model tuning — are the ones you've invested most in.

If the itch is "I want Claude Code to see my vault too," host MCP *from* the
plugin. If the itch is "the agent loop isn't good enough," that's an argument for
improving `runAgent` or for using a better client on top of a hosted endpoint —
either way, still not an argument for deleting the native side.

One honest caveat: extracting the pure-markdown tools (wiki, memory, RAG) into a
shared module with no Obsidian imports would make them testable in CI *and*
server-ready later, at low cost. That's worth doing regardless of which way this
decision goes.
