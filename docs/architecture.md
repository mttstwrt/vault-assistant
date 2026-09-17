# Architecture

An Obsidian plugin: TypeScript bundled by esbuild into one `main.js` that
Obsidian loads. No runtime dependencies — everything ships in the bundle, which
is also why the vault is reached through Obsidian's own APIs rather than
through the filesystem, and why nothing here assumes a shell.

## The components

**`main.ts`** owns the plugin lifecycle and nothing else: settings, commands,
the chat view's registration, the vault listeners that keep the semantic index
fresh, and the timer behind scheduled runs. Anything that runs the agent takes
an [`AgentDeps`](agent/README.md#what-a-run-borrows) from it — one object rather
than five arguments — though the views still read `plugin.settings` directly,
since settings change under them and a snapshot would go stale.

**[The agent](agent/README.md)** is the loop: call the model, run the tools it
asks for, feed the results back, repeat until it answers. It owns the tool
surface and the permission model, and it is the only thing that decides whether
a write may happen.

**[Retrieval](retrieval/README.md)** is how the agent finds things — the wiki it
navigates by link, the semantic index, the pre-pass, and the notes a typed
`[[link]]` attaches. Four mechanisms, one principle.

**[The API layer](api/README.md)** speaks to an OpenAI-compatible endpoint:
buffered and streaming chat, embeddings, model discovery, and the llama.cpp
extras that only llama.cpp understands.

**The panel** (`ui/`) is a view, its modals, and the renderers they share. It
holds the conversation as a record and derives everything else from it (see
*the record* below).

**Workflows** (`workflows/`) run the agent unattended, round after round, with a
run note as the only memory between rounds.

**MCP** (`mcp/`) connects other tool providers — a subprocess, an HTTP server,
or another installed plugin's API called in process — and namespaces their tools
into the same surface the built-ins live in.

## The record, and what is derived from it

The conversation is a list of `TranscriptEntry` (`types.ts`): everything the
panel showed, in order — messages, the model's reasoning, tool calls with their
results, write diffs, approvals, errors. Two things are projected from it and
neither is kept beside it:

- the message list the endpoint receives, by `transcript.toMessages`, which
  drops reasoning (shown and stored, never sent back) and everything that was
  never a message;
- the saved note, by `transcript.renderTranscript`, and read back by
  `parseTranscript`.

One record and two projections, rather than two records that can disagree. This
is what lets a reopened conversation show what the live one showed, and what
makes rewinding a turn possible at all — you cannot fork what you never
recorded. The format is described in `transcript.ts`.

## A message, end to end

1. The panel records your message, resolving any `[[links]]` you typed and
   attaching those notes to it ([retrieval](retrieval/README.md)).
2. It rebuilds the system prompt: your instructions, the live permission and
   tool description, operating memory, the wiki pointer, what you have open,
   and — when enabled — the pre-pass's findings.
3. It projects the record into messages and hands them to
   [`runAgent`](agent/README.md).
4. The loop calls the endpoint. Tool calls are executed, gated by the permission
   model, and their results fed back. Each turn reports to the panel as it
   happens, and each report becomes an entry.
5. The transcript is written, named by the model on its first save.

## A workflow round

A run's memory is its run note, not a conversation. Each round re-reads that
note, runs the workflow's steps as separate bounded conversations, and appends
each step's final answer back to it. So a run survives a restart, can be resumed
with a fresh budget, and never outgrows the context window. Out-of-scope writes
are auto-denied on autonomous steps, because there is nobody to ask.

## Which way dependencies run

```
main.ts ─┬─> ui/ ──────────> agent ──> tools/ ──> permissions
         ├─> workflows/ ───> agent      │  └─────> api/
         ├─> mcp/ <─────────────────────┘
         └─> rag/ ──────────────────> api/
                        all ──> types.ts, settings.ts
```

Two rules hold this together, and both are load-bearing:

- **`permissions.ts` depends on nothing but Obsidian and the settings type.**
  Everything may depend on it, which is what lets `inFolder` — the primitive
  both "readable" and "writable" are defined in terms of — live there without a
  cycle. `tools/paths.ts` already depends on it, which is why the primitive
  could not live there instead.
- **`settings.ts` is shape and defaults only.** The screen that edits it is a
  view (`ui/settings-tab.ts`), and the agent's prompt text is its own leaf
  module (`system-prompt.ts`) because `settings.ts` needs it as a value and
  `prompts.ts` needs the settings type — which would otherwise be a cycle at
  module-initialisation time, not merely a type one.

## Mobile

`isDesktopOnly` is false, and that decides real things. There is no shell, so
search is implemented in process rather than shelling out to grep — which also
keeps the read blocklist enforced by the same function every other tool calls,
instead of by argv quoting. MCP servers over stdio are desktop-only; HTTP and
in-process plugin servers work everywhere. The conversation importer's Claude
Code source reads a local directory and is desktop-only; the export-file sources
are not.

---

Docs index: [README.md](README.md) · Repository README: [../README.md](../README.md)
