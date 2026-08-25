# Context pre-pass: a research pass, not a grep

## Why the pre-pass exists

One GPU, one small model, a context window that fills fast. Discovery is what
eats it: the main thread spends rounds listing folders, opening the wrong note,
and reading three pages to use two lines — and every one of those results stays
in the context for the rest of the conversation. The pre-pass is meant to do
that work somewhere else and hand over only what survived, so the answering
thread starts with the relevant material already in front of it and its window
spent on the answer.

## What it does today

One model call with no tools turns the message into 2–4 search strings, and
each string is grepped across the vault for a literal, case-insensitive
substring; every hit contributes its path and a 120-character window.

- The queries are guesses. The model that writes them has seen the user's
  message and nothing else — not a folder, not a filename, not a note. Ask
  about "workouts" when the note says "gym sessions" and the pass finds
  nothing at all.
- Nothing is ever read as a note. `cachedRead` is called, so the paths and
  snippets are real rather than invented, but a 120-character window around a
  keyword is not context — it is evidence that a keyword occurred.
- The yield is at most 4 × 4 × ~120 characters, about 2KB, against a
  6000-character budget it never approaches.

So it cannot do the job it exists for. A pass that guesses vocabulary can only
find notes that already share the user's wording, which is exactly the case
where the main thread would have found them by itself.

## Requirements

- **R1 — Ground the search.** Decide what to look for by looking at the vault
  (listing, searching, the wiki index), not by guessing from the question.
- **R2 — Read what it finds**, as notes, not as keyword windows.
- **R3 — Hand over a digest that cites real paths**, so the answering thread
  can go straight to a note it needs in full.
- **R4 — Bounded and interruptible.** A hard cap on model calls, and Ctrl+C
  stops it — each step is a full generation on the one GPU.
- **R5 — Read-only.** No write tool is offered, so the pass can never change a
  note and never has to stop and ask.
- **R6 — Degrade to a normal turn.** Any failure leaves the conversation
  exactly as it would have been with the pre-pass off. Unchanged from today.
- **R7 — Show its work**, in the section added for it: reasoning while it
  thinks, and the notes it opened.
- **R8 — Keep the answering thread's context small.** The pass reads and
  discards in its own history; only the digest crosses over.

## Acceptance

- A vault where the answer lives in a note whose wording differs from the
  question: the block names that note and carries the text that answers it.
- The offered tool list contains no writer, checked in a test rather than by
  reading the prompt.
- Ctrl+C during the pass stops it before the next model call.
- Budget exhausted with nothing found: the turn proceeds as if the pre-pass
  were off.
