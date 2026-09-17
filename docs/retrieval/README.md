# Retrieval

**Responsibility.** Everything that puts vault content in front of the model:
the wiki it navigates by link, the semantic index, the pre-pass, and the notes a
typed `[[link]]` attaches.

**Not its responsibility.** Deciding whether the model may see a note — that is
[the permission model](../agent/README.md#the-permission-model), and every path
here passes through it. Retrieval narrows what is *worth* showing; it never
widens what is *allowed*.

## The principle these four share

**Cheap entry, lazy explore.** Nothing loads a corpus into the prompt. What goes
in at session start is a pointer small enough to be free; following it is the
agent's job, one tool call at a time.

This is why there are two knowledge stores rather than one, and the distinction
is worth holding onto:

- **Operating memory** (`AI/Memory.md`) is *how this vault works* — where data
  lives, the user's conventions, corrections they have given. Small, curated,
  injected in full at the start of every conversation, so durable facts cost
  zero tool calls.
- **The wiki** (`AI/Wiki/`) is *what is in this vault* — synthesised knowledge,
  interlinked. Never injected. What goes in is a compact pointer to its `Home`
  page; the agent enters there and follows `[[links]]` toward a topic.

## Why a wiki and an index, when either could stand alone

They fail differently, and each covers the other's failure.

A wiki alone cannot recall a detail nobody thought to write a page about, and it
is only as good as its curation; cold-start is weak. An index alone returns
disconnected passages with no structure — it cannot say how two ideas relate,
cannot dedupe, cannot be read or corrected by the user, and drifts as the vault
grows.

Together, the index is the fuzzy entry ("something about X, somewhere") and the
wiki is the structured destination. Indexing the wiki pages into the same index
(opt-in) is what lets a vague query land directly on a curated page rather than
on the raw note it was synthesised from.

## The four mechanisms

**The wiki** — `tools/graph.ts`. `wiki_home` reads the curated entry page;
`wiki_page` reads one page *with its neighbours* so a hop costs one round rather
than two; `list_wiki` is the sitemap and the maintenance worklist (orphans,
broken links), meant for curation rather than as the way in. `buildWikiHomePointer`
produces the session-start pointer.

**The semantic index** — `rag/`. Opt-in, because indexing sends note text to an
embedding endpoint. Chunked on headings, embedded in batches, stored in the
plugin folder and never in the user's notes, updated incrementally as files
change, and re-embedded only where the content hash moved. Blocked folders never
get a vector. Changing the embedding model invalidates the index, because
vectors from two models are not comparable.

**The pre-pass** — `prepass.ts`. Opt-in. One cheap model call turns your message
into a few search queries, runs them, and injects the hits. Built for small
local models, which ground better and burn fewer tool rounds when the relevant
notes are already in front of them. It degrades quietly: a failure is a normal
turn, not an error.

**Typed links** — `wikilinks.ts`. A `[[link]]` in the chat box is an unambiguous
"this note, please", and everything needed to honour it is already loaded — so
it is resolved by parser, with no model call, and attached to the message rather
than costing a tool round. It goes into the *message*, not the system prompt,
unlike the pre-pass and open-files blocks: those describe *now* and are rebuilt
each turn, while a note pulled in on turn one is still the subject on turn five,
and a reopened transcript has to give the model the context it had originally.

## The fence, and who has to know about it

An attached note is wrapped in the delimiters in `inlined.ts`, and three readers
must respect them:

- the transcript parser, because an attached note can itself be a saved
  conversation whose turn headings would otherwise split one turn into four;
- the conversation chunker, because that text is a copy of a note already
  indexed under its own path, and embedding it would return the same passage
  twice under two names;
- anything else that reads a transcript as structure.

The fence lives in its own module for exactly that reason: four things must
agree about it and none of them owns it.

## Invariants

1. **Every candidate passes `isReadable`.** In the indexer this is the privacy
   boundary: a blocked note never gets a vector, so it can never be surfaced by
   a search that does not re-check.
2. **Nothing here loads a whole corpus.** A retrieval tool that returns
   everything is a bug, not a convenience — `list_wiki` is the sitemap, not the
   entry point, and the system prompt says so.
3. **The opt-ins stay opt-in.** Semantic search and the pre-pass both send vault
   text somewhere the user did not explicitly ask for it to go on that turn.
   Anything new that transmits vault contents is opt-in, disclosed in the
   repository README, and respects the read blocklist.

---

Docs index: [../README.md](../README.md) · [architecture.md](../architecture.md) · [agent/](../agent/README.md) · [api/](../api/README.md)
