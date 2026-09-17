# The agent

**Responsibility.** Drive the loop — call the model, run the tools it asks for,
feed the results back, repeat until it answers or hits the step limit — and
decide whether each action it asks for is allowed.

**Not its responsibility.** Deciding what to say (that is
[the prompt](#what-the-model-is-told)), speaking to the endpoint (that is
[api/](../api/README.md)), or drawing anything. The loop reports what happens
through callbacks and never touches the DOM; that is why the same loop runs a
chat turn, a workflow step and a headless scheduled run unchanged.

## Public interface

- `runAgent(deps, grants, history, events, opts)` — `agent.ts`. Mutates and
  returns `history`. Everything it reports (`AgentEvents`) is optional except
  `requestApproval`, which it must be able to call.
- `executeTool(ctx, name, argsJson, offered)` — `tools/vault-tools.ts`.
- `TOOL_SPECS` / `activeToolSpecs(settings)` — `tools/specs.ts`, the schemas the
  model is given. Separate from dispatch because asking *which tools exist*
  should not drag in *what happens when one is called*; `prompts.ts` and
  `capabilities.ts` want only the names.
- `buildSystemPrompt(app, settings)` — `prompts.ts`.

### What a run borrows

`AgentDeps` is the app, the settings, a settings-saver, the MCP manager and the
semantic index. `SessionGrants` is the approvals the user gave for the rest of
one conversation — scoped to the conversation, which is why it travels beside
the dependencies rather than inside them. `ToolContext` is those two plus the
callbacks, which is all it ever was.

**Dependencies.** `api/` for the calls, `tools/` for the surface,
`permissions.ts` for the gate, `mcp/` for external tools, `rag/` for
`semantic_search`. **Dependents:** the chat panel and the workflow runner.

## The permission model

Reads are default-allow, writes are default-deny, and both are decided by one
predicate in `permissions.ts`.

- **Read.** The whole vault except the folders the user blocked. A blocked file
  is not merely unreadable, it is *invisible*: `findNote` never matches or
  suggests one, `search` and `tags` skip it, `list_files` omits it, and
  `open_files` will not name it. The agent cannot learn that it exists.
- **Write.** Only inside the writable folders, plus the agent's own working
  folders (conversations, wiki, memory, runs, workflows, goals), which are
  always both readable and writable. Anything else pauses and asks.

### Invariants a new tool must uphold

1. **Every path goes through `findNote`, `findFolder` or `isReadable` before it
   is read.** That is the privacy boundary. A tool that reads a path some other
   way has a hole in it.
2. **Every write goes through the `ensureWritable` / `ensureMovable` /
   `ensureFolderAllowed` gate.** They return an error string to hand back to the
   model, or null to proceed. A denial is a normal result, not an exception.
3. **A write that is not a whole-file replacement uses `Vault.process`.** It
   re-reads under Obsidian's own lock, so an edit the user makes while the agent
   is deciding what to write is not silently discarded — which is exactly what a
   read-then-modify pair does. `write_section` additionally abandons the write
   if the file changed under it, because its offsets came from the metadata
   cache and splicing at stale ones would corrupt the note. Refusing beats
   guessing.
4. **A structural change goes through Obsidian, not around it.**
   `FileManager.renameFile` is the same code path as dragging a note in the file
   explorer, so links follow. `Vault.rename` is the trap: it moves the file and
   leaves every link pointing at nothing.
5. **Tell the truth about what happened.** `move_file` counts backlinks before
   and after and reports whether they actually followed, rather than predicting
   that they will — because whether they do depends on a setting in the user's
   vault.

### Approvals

`requestApproval` returns one of: deny, once, session, always-file,
always-folder, always-trust. The last three widen the stored allowlist, through
`grantWrite`, which skips anything already covered so repeated grants do not
pile duplicates into the user's settings. A move asks once for the whole move
rather than twice for its halves — approving the removal but not the arrival is
not a state anyone wants to be in.

During an autonomous workflow step there is nobody to ask, so out-of-scope
actions are auto-denied rather than stalling the run.

## What the model is told

`buildSystemPrompt` assembles: the user's instructions, then a live description
of what the agent can reach, then the environment, then operating memory, then
the wiki pointer. The panel appends what you have open and, when enabled, the
pre-pass's findings — both stripped and rebuilt each turn so they never pile up.

Two of these are generated rather than written down, so they cannot drift:

- the **access block** names the tools this request actually got, and states the
  boundary as environment rather than advice, because models trained as coding
  agents otherwise spend rounds trying `ls` and `cat`;
- the **`capabilities` tool** answers from live settings — which folders, which
  tools, and above all whether this vault has "Automatically update internal
  links" on, which decides whether links survive a move and is not something a
  model can reason its way to.

When a model reaches for a tool that does not exist, `tools/aliases.ts` decides
what it meant. A read-only call under a familiar name (`ls`, `cat`, `grep`) runs
as its vault equivalent; anything that could change a file gets a correction
naming the right tool instead. Guessing is only ever done where the worst case
is an unhelpful listing.

---

Docs index: [../README.md](../README.md) · [architecture.md](../architecture.md) · [retrieval/](../retrieval/README.md) · [api/](../api/README.md)
