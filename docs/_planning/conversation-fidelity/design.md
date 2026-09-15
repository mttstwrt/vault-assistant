# Design: a conversation you can reopen whole

Requirements: [requirements.md](requirements.md)

## 1. Approach

### 1.1 The panel's record becomes a real model

Today two things are kept in parallel and neither is the record: `history`
(`ChatMessage[]`, what the model sees) and the DOM (what you see). Anything
that is not a model message — a diff, an approval, an error — exists only in
the DOM, which is why it cannot be saved.

Introduce `TranscriptEntry`: the ordered list of everything the panel showed.

```ts
type TranscriptEntry =
  | { kind: 'user'; text: string; attached?: Expansion }
  | { kind: 'assistant'; text: string; reasoning?: string;
      thoughtMs?: number; stats?: CallStats; aborted?: boolean }
  | { kind: 'tool'; call: ToolCall; result: string }
  | { kind: 'change'; change: FileChange }
  | { kind: 'approval'; request: ApprovalRequest; decision: ApprovalResult }
  | { kind: 'error'; message: string }
  | { kind: 'info'; text: string };
```

`history` becomes derived: one function projects entries to the `ChatMessage[]`
the endpoint gets, dropping `reasoning` (which must never go back — the type
already says so) and every entry that is panel-only. That removes the current
duplication rather than adding a third copy.

This also fixes the reasoning leak: `runAgent` currently discards
`result.reasoning` after handing it to the UI. It becomes part of the entry.

### 1.2 The file format

Markdown, extended, with HTML comments as the machine layer:

```markdown
## 🧑 You

what changed in Notes/Ideas.md?

<!--va attached--> ↘ inlined [[Notes/Ideas.md]] (1.2k)

## 🤖 Assistant

<!--va thinking 4.2s-->
~~~~text
the model's reasoning…
~~~~

Looking at it now.

<!--va tool list_files-->
~~~~json
{"path": "Notes", "depth": 2}
~~~~
~~~~text
Notes/Ideas.md
Notes/Todo.md
~~~~

Two notes, and Ideas.md changed on Tuesday.

<!--va stats--> 4.2s · 312 tokens · 47 tok/s
```

Four properties earn this shape:

- **HTML comments vanish in reading view.** Obsidian renders nothing for them,
  so the note reads as prose with fenced blocks — and the marker is
  unambiguous to parse, unlike a heading or an emoji prefix that a tool result
  could contain.
- **Fences, not callouts.** `wikilinks.ts` already rejected callouts for the
  inliner, in its own words, because they need `> ` on every line and mangle
  any code block inside. The same argument applies here and the codebase should
  not contradict itself.
- **Fence length is computed, not fixed.** The opening fence is one backtick or
  tilde longer than the longest run already in the payload — CommonMark's own
  rule. This is what makes requirement §2.6 hold for a tool result that is
  itself a transcript.
- **Old transcripts still parse.** The existing `## 🧑 You` / `## 🤖 Assistant`
  / `> 🔧` markers keep their meaning; everything new is additive.

**Collapsing.** A long tool result is loud in reading view. The options are
`<details>` (collapses, but its contents stop being markdown), a callout
(rejected above), or leaving fences open. Recommended: leave them open and cap
what is written at the same limit the panel caps display at — 2,000 characters
per tool result, which is already the rule on screen and therefore already the
definition of "what you saw".

### 1.3 Reading it back

`parseConversation` becomes a small state machine over the marker set rather
than the current line scanner. It keeps the fence tracker from `wikilinks.ts`
that stops an inlined transcript from splitting a turn, and gains the same
protection for the new blocks.

### 1.4 Append stays append

`appendConversation` already exists so a reopened conversation adds turns
rather than re-rendering. It now appends rendered entries instead of messages.
`persistedCount` counts entries.

## 2. The decision this rests on: branching

llama.cpp's WebUI models a conversation as a **tree**. Editing any earlier
message or regenerating any answer forks a branch at that point, and you move
between branches freely. It is the centre of its conversation model, not a
feature beside it.

This design deliberately does not copy that, and the reason is the substrate.
llama.cpp's conversations live in IndexedDB: invisible, disposable, never read
by anything but the app. Here the transcript is a note in someone's vault —
linked, searched, embedded, read months later. A tree serialised into a
markdown note is either nested callouts nobody can read or a JSON blob that is
not a note, and requirement §2.3 rules out both.

**The translation worth making instead: a branch is a new note.** Editing turn
five forks a fresh transcript that links back to its parent with a
`[[wikilink]]`. The vault's link graph becomes the tree, `links` and backlinks
already navigate it, and each branch stays a readable linear document. That is
llama.cpp's feature expressed in Obsidian's vocabulary rather than transplanted
from a browser database.

It is out of scope here and wants its own change, but the entry model above is
what makes it possible later: you cannot fork a turn you never recorded.

## 3. Alternatives

| Considered | Why it lost |
| --- | --- |
| Sidecar JSON in the plugin data folder (Claude Code's JSONL, llama.cpp's IndexedDB) | Two files that desync when a note moves, and the record stops being the thing the user's backup and sync carry. Breaks "the note is the artifact", which is the whole premise. |
| A fenced JSON block at the end of the note | Exact round-trip, trivial to parse, and doubles the file while putting a wall of machine text where a reader scrolls. |
| Obsidian callouts for every block | `wikilinks.ts` already rejected these for the inliner, for reasons that apply unchanged. |
| Keep the format, store only what parses today | Restates the problem as a decision. |
| A conversation tree in the note | §2. |
| Raise the tool-result cap for storage above the display cap | Writes something you were never shown, and makes a transcript's size unbounded in the one direction nobody controls. |

## 4. Impact

- **New:** `types.ts` gains `TranscriptEntry`; `conversation.ts` gains a
  renderer and a parser for it.
- **Changed:** `agent.ts` (reasoning reaches the caller), `chat-view.ts`
  (records entries; rebuilds from them on open), `rag/chunk.ts` (must skip the
  new blocks as it already skips inlined notes), `wikilinks.ts` (the fence
  tracker generalises).
- **Risk, in order:** a parser that mis-splits a transcript containing another
  transcript (requirement §2.6 exists to force this case into the acceptance
  run); a reopened conversation whose derived `history` no longer matches what
  the endpoint saw, which shows up as the model losing the thread; transcript
  size on conversations with many tool calls.
- **Not affected:** permissions, the tool surface, workflows, MCP. A workflow
  run note is a different artifact and does not change.

## 5. Assumptions

- **You want fidelity in the note, not beside it.** Stated directly: loaded
  conversations come with everything. If the intent were only that *reopening*
  is faithful, a sidecar would be cheaper and this design is wrong.
- **The 2,000-character display cap is the right definition of "everything".**
  It is what the panel shows now. If the real want is the untruncated result,
  that is a different cap in both places, not just in storage.
- **Old transcripts are worth keeping readable** rather than rewriting on
  first open. Rewriting would be a migration over the user's own notes, which
  is not something to do without asking.

## 6. Adjacent parity items, not in this change

Found while looking at the reference UIs; each is small and independent.

- **Live generation stats.** llama.cpp emits `timings` on every streamed chunk
  when the request carries `timings_per_token: true`. `stream.ts:117` already
  captures them and keeps only the last, so the ring and the tok/s reading move
  once per turn where llama.cpp's own gauge moves continuously. Small change,
  visible effect.
- **Sampler defaults from the server.** `/props` returns
  `default_generation_settings` — temperature, top_k, top_p, penalties, the
  sampler order. The plugin reads `n_ctx` out of that object and ignores the
  rest, then sends its own hardcoded `temperature: 0.7` on every request. So
  launching `llama-server --temp 0.4` is silently overridden. llama.cpp's UI
  seeds its controls from these instead.
- **Message actions.** Regenerate and edit-and-resend, as truncate-and-resend
  until branching exists.
- **Commands for what only the header offers.** New chat and open-previous have
  no command, so they cannot be given a hotkey; llama.cpp's UI binds both.

---

Repository README: [../../../README.md](../../../README.md)
