# Requirements: a conversation you can reopen whole

Design: [design.md](design.md)

## 1. Why this exists

A saved conversation is lossy, and it is lossy in the places that carry the
work. Reopening one gives back your messages and the agent's prose. Everything
that made the answer — what it looked at, what came back, what it changed, what
you allowed, what it cost — is gone.

Measured against what the panel shows while the conversation is live:

| Shown live | In the transcript |
| --- | --- |
| Your message | yes |
| What a typed `[[link]]` attached | the text, not the record of it |
| The model's thinking | **no — not even held in memory** |
| The answer | yes |
| A tool call and its arguments | the call only |
| What the tool returned | **no** |
| The diff of a write | **no** |
| An approval and how you answered it | **no** |
| Errors | **no** |
| Time, tokens, tokens/second | **no** |

The thinking case is the sharpest: `LLMResult.reasoning` is rendered into the
panel and then dropped on the floor. It never reaches `history`, so it is gone
the moment the turn ends, saved or not.

Both reference UIs keep everything. llama.cpp's WebUI persists whole
conversations to IndexedDB and can export them as JSON; Claude Code keeps a
JSONL log of every event in a session and resumes from it. Neither shows you
one thing and stores another.

## 2. What must be true when this is done

1. Reopening a saved conversation restores what the panel showed when it was
   live: thinking, tool calls with their results, write diffs, approval
   decisions, errors, and per-turn statistics — not just the prose.
2. The model gets back exactly the history it had, so a continued conversation
   behaves as though it had never been closed. Reasoning is restored for
   display and never sent back to the endpoint.
3. A transcript is still a note: readable top to bottom in Obsidian's reading
   view, searchable by Obsidian's own search, and safe to link to. Someone who
   opens one to read it must not have to scroll past machinery.
4. Transcripts written by the current version still open. A conversation saved
   before this change loads with whatever it has, and gains nothing it never
   recorded.
5. `ragIndexConversations` still embeds your turns and the agent's final
   answers, and still embeds neither tool output nor inlined note text.
6. A tool result containing code fences, `---`, or transcript headings
   round-trips unchanged. This is not hypothetical: `read_file` on a saved
   conversation returns all three.
7. Nothing in a transcript is written that the panel did not show. The privacy
   rule is unchanged — the note records what happened, it does not collect more
   than happened.

## 3. Non-goals

- **No conversation tree.** Settled in design §2; branching, if it is built,
  is a separate change and a different shape.
- **No new storage outside the vault.** The note is the record. A sidecar in
  the plugin folder would desync the moment a note is moved, and would not be
  the thing the user's backup captures.
- **No format that only this plugin can read.** A transcript that is a JSON
  blob in a `.md` wrapper is not a note, and the whole premise is that
  conversations join the vault as notes.
- **No migration of old transcripts.** They are valid; they simply carry less.

## 4. Acceptance

- Save a conversation with a thinking model that calls two tools and writes a
  file, with one approval. Close it, reopen it: the thinking section, both tool
  cards with their results, the diff, the approval outcome and the stats are
  all there.
- Continue that conversation. The model's next answer shows it still has the
  earlier tool results in context.
- Open the same transcript as a note. It reads as a conversation, with the
  machinery collapsed or unobtrusive.
- `read_file` a saved transcript from inside a chat, then save *that*
  conversation, then reopen it. Nothing has split or nested wrongly.
- A transcript saved by the previous version still opens.
- `npm run build` and `npm run lint` pass.

---

Repository README: [../../../README.md](../../../README.md)
