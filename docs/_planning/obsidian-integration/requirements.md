# Requirements: knowing itself, and reaching Obsidian properly

**Status:** Draft for review · **Date:** 2026-08-31

Eight changes with one thing in common: the agent currently works *around*
Obsidian instead of *through* it. It rewrites whole notes because it cannot
address a section, it creates dummy `.md` files because it cannot create a
folder, it declines to move a note because it has no mover — and it cannot say
which of those is true, because nothing in the plugin describes the plugin to
the model.

## 1. Why now

**The agent does not know what it is.** Asked "if you move a note, does Obsidian
update the links to it?", it has nothing to answer from. The system prompt gives
it a list of tool *names*; the tool specs give one sentence of *purpose*. Neither
says what happens in the vault when a tool runs, which settings are on, or how
Obsidian itself behaves around the edges. So it guesses, and a guess about a
destructive operation is worse than a refusal. The same gap makes it claim
abilities it does not have and refuse ones it does.

**It cannot move a note, so it invents.** `redirectTool` answers `mv`, `rename`
and `mkdir` with "this plugin cannot delete, move, copy or rename files. Tell the
user what you would like changed and let them do it in Obsidian." Watching a
model reorganise the conversations folder under that constraint is instructive:
it created placeholder `.md` files to bring folders into existence, then deleted
them — except it cannot delete either, so it emptied them instead. Meanwhile
Obsidian has had the right primitive since 0.11: `FileManager.renameFile` is the
same code path as dragging a note in the file explorer, and it rewrites every
`[[link]]` that pointed at the note.

**Retrieval is all-or-nothing.** `read_file` returns the whole note. For a 400-line
note where the answer is under one heading, that is the entire note in context and
the entire note back out again if anything is edited — and a small model that
rewrites a long note from memory will truncate it. There is no way to ask what
headings a note *has*, no way to fetch one section, and no way to write one back.

**`search` is a substring scan wearing a search tool's clothes.** No regular
expressions. One hit per file, so a note that mentions a term twelve times reports
once. No line numbers, so a hit cannot be turned into a location. No way to scope
it to a folder. `redirectTool` maps `grep`, `rg` and `ripgrep` onto it, which
means a model asking for grep gets something meaningfully weaker and is not told.

**Typed `[[links]]` are dead text.** Writing "compare [[Notes/Chunking]] with
[[Notes/Embedding#Cost]]" in the chat box sends thirty-eight characters that
Obsidian would resolve instantly and the model must spend two tool rounds
guessing at — if it recognises them as links at all. Everything needed to resolve
them is already loaded: `metadataCache.getFirstLinkpathDest` for the note,
`resolveSubpath` for the `#section`.

**Tags and headings are invisible.** `metadataCache` holds every tag and every
heading in the vault, already parsed, costing no file reads. The agent can reach
none of it. Asking "what have I tagged #project" means a full-text scan for a
string that also appears in prose.

## 2. Goals

**OBS-1 — Self-inspection.** A `capabilities` tool that reports, generated from
live state rather than written down once: which tools this request actually has
and which are switched off by which setting, what the read and write scopes are
and what happens when a write falls outside them, how Obsidian will behave for
the operations where that is not obvious — link updating on a move above all —
and what the plugin genuinely cannot do. The system prompt gains one line telling
the model to call it before claiming it can or cannot do something.

The specific bar: asked *"if I have you move a note, does Obsidian automatically
update links to it?"*, the answer names Obsidian's **Automatically update
internal links** setting, says whether it is on **in this vault**, and says what
the tool does about it either way. Not a hedge, not a guess.

**OBS-2 — Typed `[[wikilinks]]` resolve before the model sees them.** A
deterministic pre-parser — no model call — reads the message you typed, resolves
every `[[note]]`, `[[note#heading]]`, `[[note#^block]]` and `![[embed]]` through
Obsidian's own link resolution, and appends the resolved text to that message
inside a clearly labelled fence naming where each piece came from. Blocked
folders are never inlined. The panel shows what was pulled in, so it is never
silent. A setting turns it off.

**OBS-3 — Moving and renaming through Obsidian.** A `move_file` tool over
`FileManager.renameFile`, covering notes and folders, so links follow the way
they do when you drag a note yourself. It needs write permission at both ends,
and asks for approval on the same card the write tools use. Afterwards it checks
whether the backlinks actually followed and says so in its result — the tool
reports the truth of what happened, not the intention.

**OBS-4 — `create_folder`.** Creates a folder and its missing parents. The
motivating bug is literal: the agent has been building folders out of dummy notes
because this did not exist.

**OBS-5 — Sections, not whole files.** Three tools over Obsidian's own metadata:
`outline` (a note's heading tree, frontmatter keys and counts — no content),
`read_section` (one heading's section, or one `^block`, resolved exactly the way
Obsidian resolves `[[note#heading]]`), and `write_section` (replace or append
within one section, leaving the rest of the note untouched). The third is not
optional: shipping cheap section *reads* without section *writes* invites a model
to read one heading and then rewrite the whole note around it.

**OBS-6 — `search` becomes a real search.** Regular expressions, every match in a
file rather than the first, line numbers on every hit, an optional folder to
scope to, a paths-only mode for cheap breadth, and grep's useful flags spelled
the way grep spells them: case sensitivity, whole word, invert, context lines,
and a multiline mode. It stays in-process rather than shelling out to grep or
ripgrep — design §2.3 gives the four reasons, of which the load-bearing two are
that mobile and Windows have neither, and that the read blocklist is safer
enforced by the function every other tool already calls than by `--exclude-dir`
arguments. `list_files` gains an optional depth so a folder tree can be seen in
one call instead of one call per level.

**OBS-7 — `tags`.** With no argument, every tag in the vault and how many notes
carry it. With a tag, the notes carrying it. Read entirely from `metadataCache`,
so it touches no file contents.

**OBS-8 — The alias table stops lying.** `mv`, `rename`, `mkdir` and friends
currently produce "this plugin cannot move or rename files". After OBS-3 and
OBS-4 that is false, and a false correction is worse than no correction. They
become redirects to the real tools. Delete and copy stay unsupported, and keep
saying so.

**OBS-9 — Defer to Obsidian where the existing code does not.** The rule for
everything above is that an Obsidian function beats a hand-rolled equivalent.
Applied to the code already here, it finds three places that predate the rule and
should move: `append_file`, `remember` and `update_wiki` read-then-write in two
steps where `Vault.process` would be atomic (an edit the user makes in between is
silently discarded today — this is a bug, not a preference); `paths.ts` resolves
a bare filename with a hand-rolled basename scan that misses frontmatter aliases,
where `getFirstLinkpathDest` is Obsidian's own answer; and the wiki tools tell
the model to hand-write `[[wikilinks]]` where `generateMarkdownLink` would honour
the link format the user actually chose. Design §1 has the audit, including the
two places the rule does not apply and the one still open.

## 3. Non-goals

- **No delete, no copy.** Deletion is the one operation with no undo inside the
  plugin's model of the vault, nobody asked for it, and Obsidian's own file
  explorer is two clicks away. `trashFile` is a one-line change whenever it is
  actually wanted; the decision not to make it is the point.
- **No new model calls.** The wikilink pre-parser is a parser: `metadataCache`
  and string slicing, nothing else. It runs on every message, so it must cost
  nothing and never fail a turn.
- **No rewriting of what the user typed.** The inliner appends; the sentence you
  wrote stays the sentence you wrote, `[[links]]` and all.
- **No general patch/diff editing.** `write_section` addresses a *heading*,
  which Obsidian already defines. Line ranges, fuzzy string replacement and
  patch application are a different subsystem with a different failure mode, and
  they are not needed to stop the whole-note-rewrite problem.
- **No shell execution.** Nothing in this change spawns a process. The plugin is
  not desktop-only, and the search that would have justified it is portable
  instead (design §2.3).
- **No link autocomplete in the chat composer.** Obsidian's own suggester is
  editor-only and the supported out-of-editor one will not attach to a
  `<textarea>` (design §8.4). What ships instead is a named near-miss when a
  typed link resolves to nothing, which is where most of the value was.
- **No frontmatter tool, no "open this note in Obsidian", no daily-note
  integration, no vault-wide broken-link report, no recently-modified list.**
  Each is defensible; none is load-bearing here. Design §12 records why, so the
  next change starts from the argument rather than from scratch.
- **No new settings beyond one toggle** for the inliner. In particular no setting
  gating `move_file`: the write permission model already gates it correctly —
  by default the agent may move things around inside its own folders and must
  ask for anything else, which is exactly the desired behaviour.
- No change to the wiki, memory, workflow, MCP, import or streaming subsystems.

## 4. Acceptance

Self-inspection:

1. "If I have you move a note, does Obsidian automatically update links to it?"
   is answered with the state of **Automatically update internal links** in this
   vault, not a hedge. Turning that setting off in Obsidian and asking again
   changes the answer.
2. "Can you delete a note?" → no, and it says what to do instead. "Can you make a
   folder?" → yes, naming `create_folder`. With semantic search off, "can you
   search by meaning?" names the setting that would enable it.
3. The report never lists a tool this request was not offered, and never omits
   one it was.

Typed links:

4. "Summarise [[Notes/Ideas]]" answers without a `read_file` round.
5. `[[Notes/Ideas#Chunking]]` inlines that heading's section including its
   subheadings, and nothing else from the note.
6. A link into a blocked folder inlines nothing and says so; the note's contents
   never reach the endpoint.
7. A message with more links than the budget allows inlines what fits and names
   the rest, rather than truncating mid-note or blowing the context window.
8. The panel shows which notes were inlined and how much was pulled in.
9. Saving, closing and reopening a conversation that used inlining gives the
   model the same context it had before, and the transcript still parses into
   exactly the turns that were in it — including when the inlined note is itself
   a saved conversation containing `## 🧑 You` headings.
10. With the setting off, `[[links]]` are sent verbatim and nothing is inlined.

Moving and folders:

11. Renaming a note that six other notes link to updates all six, and the tool's
    result says so — verified by `links` afterwards, and by opening the vault.
12. Moving a note into a folder that does not exist creates the folder.
13. Moving a folder moves its contents and their links.
14. A move whose source or destination is outside the writable folders raises the
    approval card, naming both paths, and denying it leaves the vault untouched.
15. Moving the note that holds the conversation currently open in the panel does
    not resurrect the old path on the next save.
16. `create_folder` creates nested parents in one call, and creating a folder
    that already exists succeeds quietly.

Sections and search:

17. `outline` on a long note returns its headings and no prose.
18. `read_section` on a heading that does not exist names the headings that do.
19. `write_section` replacing one section leaves every other byte of the note
    unchanged (verified by diff), and appending to a section inserts before the
    next heading rather than at the end of the file.
20. `search` with a regular expression returns `path:line` hits, several per file
    where several exist, and scoping to a folder searches only that folder.
    Whole-word, invert, context lines and paths-only each behave the way the
    matching grep flag does; multiline matches across a line break.
21. A malformed regular expression is reported as an error, not thrown, and a
    slow search can still be stopped from the panel. (A deliberately pathological
    pattern is not fully bounded — design §11 says why, and what is bounded.)
22. `list_files` with a depth returns the tree in one call.

Tags:

23. `tags` with no argument lists the vault's tags with counts, including
    frontmatter tags, and excludes blocked folders. `tags` with one returns the
    notes carrying it.

Deferring to Obsidian (OBS-9):

24. Editing a note in Obsidian while the agent appends to it loses neither edit
    — the agent's append lands on top of what was typed rather than replacing it.
    (The reproduction is a slow model call: type into the note while it thinks.)
25. A note found only by a frontmatter alias resolves, where today it does not.
26. With **Use [[Wikilinks]]** turned off in Obsidian, links the agent writes
    into wiki pages come out in the user's chosen format, not as `[[…]]`.
27. A typed `[[link]]` that matches no note is reported in the panel with the
    closest note named, rather than silently inlining nothing.

Everything:

28. A model asking for `mkdir`, `mv` or `rename` is routed to the real tool
    rather than told it does not exist. `rm` and `cp` still say no.
29. `npm run lint` and `npm run build` pass.
30. The tool-selection harness (design §11) is run at 13 tools before the change
    and at 20 after, on Gemma 3 27B and Qwen3 32B, and the first-call accuracy
    and rounds-to-answer are recorded. This is the risk the change carries, and
    the point is to have the number rather than an opinion; design §11 says what
    a bad number would buy.

---

Design: [design.md](design.md) · Repository README: [../../../README.md](../../../README.md)
