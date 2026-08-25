# Context pre-pass: design

Requirements: [requirements.md](./requirements.md).

## Approach

Run the agent loop that already exists, scoped: its own short history, a
read-only tool set, a small step budget. `runAgent` takes `toolFilter`,
`maxSteps`, `overrides` and `signal` already, and the workflow runner
(`src/workflows/runner.ts:244`) is the precedent for driving it this way, so
this is a new caller rather than new machinery.

`prepareContext` becomes: build a research history, run the scoped agent, take
its final message as the block. `extractQueries`, `literalSearch` and the
`PRE_PASS_MARKER` framing go with the old approach — deleted, not left behind.

## Data flow

```
user message
  └─ research history  [research system prompt, user message]   ← its own, short
       └─ runAgent(read-only tools, maxSteps N, signal)
            ├─ list_files / search / semantic_search / wiki_*   ← R1 ground it
            ├─ read_file                                        ← R2 read it
            └─ final message: digest + cited paths              ← R3
                 └─ appended to the answering thread's system prompt   ← R8
```

The research history is thrown away when the pass ends. Nothing it read
reaches the answering thread except through the digest — that is the whole
point (R8): the reading happens in a context that is about to be discarded.

## The tool set (R5)

Allowed: `list_files`, `read_file`, `search`, `semantic_search`, `wiki_home`,
`wiki_page`, `list_wiki`, `links`, `open_files`.

Refused: `write_file`, `append_file`, `remember`, `update_wiki`, and every MCP
tool — an MCP server's tools are arbitrary, may write, and may prompt.

Named as an allow-list, not a deny-list: a tool added later is refused until
someone decides otherwise, which is the safe direction to be wrong in. There is
no `writes` flag on `ToolSpec` to filter by, and inventing one would put the
decision in the place most likely to be forgotten when a tool is added.

`requestApproval` denies flatly. With no writer offered, nothing should ask; if
something does, refusing is right and the deny is the belt to the allow-list's
braces.

## Budget (R4)

`maxSteps` for the pass, separate from the conversation's, as a setting
(`prePassSteps`, default 6) beside the pre-pass toggle — decided, against a
fixed constant, because the right number is a property of the hardware and the
model rather than of the plugin, and finding it should not need a rebuild. Six
is enough to list, search, read two or three notes and write up.

The panel's abort signal goes through to `runAgent`, which checks it before each
model call.

## Output (R3) — decided

A short lead-in, then the passages it relied on quoted verbatim, each under its
real path. The research model is the answering model, so a digest written in
its own words buys compactness at the price of a paraphrase that can be wrong
without anything downstream being able to tell; a quote cannot be wrong about
what the note says. The lead-in is what a quote can't carry: why this passage,
and what was looked for and not found.

Capped at `MAX_BLOCK_CHARS` (6000, unchanged), under a marker that says where
it came from. The current marker warns the material "may be irrelevant —
verify with tools before relying on it"; that stays true in spirit but changes
in substance, since the paths are now notes actually opened.

## Alternatives

- **Read the top hits.** Keep query extraction, but open the notes it matched
  instead of quoting 120 characters. One model call, no iteration — cheapest,
  and fixes R2 but not R1: the queries are still guesses, so it still finds
  nothing when the vocabulary differs.
- **Map, then read, then summarise.** Three fixed calls: a folder listing into
  the first, chosen notes read deterministically, a summary out of the third.
  Bounded and predictable, but it cannot follow a lead — the note that names
  the note that has the answer is a dead end.
- **Chosen: the scoped agent.** Costs an unpredictable number of calls, which
  the budget bounds, and reuses the loop, the tools, the approval path and the
  panel's tool rendering rather than restating any of them.

## Risks

- **Latency.** N generations before the answer starts. Bounded by the budget,
  visible in the section, interruptible, and the whole feature is opt-in.
- **A small model loops** — searching the same thing repeatedly. The budget
  caps the damage; the anti-loop penalties in settings already exist for this.
- **The digest paraphrases wrongly.** Mitigated by citing paths: the answering
  thread can open anything it needs to check, and the marker keeps saying so.
- **A pass that finds nothing** costs its budget and returns null, and the turn
  proceeds as it would have anyway (R6).
