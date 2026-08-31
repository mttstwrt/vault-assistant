# Design: knowing itself, and reaching Obsidian properly

**Status:** Draft for review · **Date:** 2026-08-31
Requirements: [requirements.md](requirements.md)

## 0. Summary

Almost everything here already exists inside Obsidian and is simply not wired to
a tool. `FileManager.renameFile` moves a file and fixes the links.
`resolveSubpath` turns `#Heading` into a byte range — the same function that
makes `[[note#heading]]` work in a note. `metadataCache` holds every heading,
tag, link and backlink in the vault, parsed, with no file reads. `Vault.createFolder`
makes a folder. The work is mostly a thin, honest layer over those, plus two
things that are genuinely new: a report the agent can read about itself, and a
parser that resolves the `[[links]]` you type in the chat box.

Seven new tools — `capabilities`, `move_file`, `create_folder`, `outline`,
`read_section`, `write_section`, `tags` — taking the built-in set from 13 to 20.
Two existing tools extended, one parser in the send path, and one correction to a
lookup table that has started telling the model things that are no longer true.

## 1. Where the code goes

`src/tools/vault-tools.ts` is already 532 lines and AGENTS.md asks for ~200–300.
Adding seven tools inline would double it. So the specs and the `executeTool`
switch stay there — that is its job, and one dispatch table is easier to read
than seven — and every implementation body lands in a module beside it:

```
src/tools/
  capabilities.ts   the self-inspection report (OBS-1)
  files.ts          move_file, create_folder, the one ensureFolder (OBS-3, OBS-4)
  sections.ts       outline, read_section, write_section (OBS-5)
  search.ts         the search implementation, rewritten (OBS-6)
  tags.ts           tags (OBS-7)
src/wikilinks.ts    the typed-link parser and inliner (OBS-2)
```

`sections.ts` is shared: the inliner resolves `[[note#heading]]` through the same
helper `read_section` uses, so the two can never disagree about what a section is.

`ensureFolder` currently exists twice — exported from `src/conversation.ts` and
private in `src/tools/vault-tools.ts`, character for character. `create_folder`
needs a third caller, which is the moment to have one: it moves to
`src/tools/files.ts` and the two copies are deleted (principle 2 — a change that
orphans code removes it).

## 2. OBS-6 — `search`, and `list_files` depth (do this first)

It changes no data flow and depends on nothing else, so it can land and be judged
alone.

### Why extend `search` rather than add `grep`

`redirectTool` already folds `grep`, `rg`, `ripgrep`, `grep_search`,
`search_files`, `find_in_files` and `text_search` onto `search`, and
`normalizeArgs` already maps `pattern` → `query`. A model that calls
`grep({pattern: "TODO.*urgent"})` reaches `search` today; it just gets a literal
substring scan for the characters `TODO.*urgent` and no indication that its regex
was taken as text. So the routing is right and the implementation is wrong.

Adding a second `grep` tool beside `search` would give the model two
near-identical options to choose between, which is precisely the choice small
models get wrong — the failure mode the pre-pass was built to work around.
Rejected for that reason.

### The tool

```ts
{
  query: string;            // literal text, or a regular expression
  regex?: boolean;          // default false — treat query as a JS regex
  path?: string;            // limit to a folder (prefix match)
  case_sensitive?: boolean; // default false
  files_only?: boolean;     // paths only, like `rg -l`
  limit?: number;           // max hits overall (default 20, max 100)
  max_per_file?: number;    // default 3
}
```

Output becomes grep-shaped, which is the shape every model already knows:

```
Notes/Chunking.md:14: the overlap carried between adjacent chunks
Notes/Chunking.md:41: chunk overlap is 200 characters
Notes/Embedding.md:7: overlap matters more than chunk size here
3 matches in 2 files.
```

Matching is per line, not per file: the line is the unit that gets a number, the
unit that gets reported, and — usefully — the unit a regular expression runs
against, which bounds how much text any single `RegExp.exec` can backtrack over.
A pattern longer than 200 characters is refused; a pattern that will not compile
comes back as `Error: "…" is not a valid regular expression: …` rather than
throwing out of the tool.

The scan is still `cachedRead` over `getMarkdownFiles()` filtered by `isReadable`,
with the `path` prefix applied first so a scoped search does not read the vault,
and the early exit on `limit` kept. `cachedRead` is the right call here and the
`await` on each file is what keeps the panel responsive across a large vault.

`literalSearch` in `src/prepass.ts` is a copy of the current implementation, kept
because the pre-pass needed the same scan and there was nowhere shared to put it.
Now there is: it calls the new module and the copy is deleted. Its caller wants a
plain snippet list rather than line-numbered hits, so the module exports the scan
and the two callers format it — one shape of the search, two renderings.

### `list_files` depth

One optional `depth` (default 1, max 4, capped at 500 entries). At depth 1 the
output is byte-for-byte what it is today. Deeper, it indents:

```
AI/
  AI/Conversations/
    AI/Conversations/Coding/
  AI/Wiki/
```

Paths stay absolute-from-root on every line even though it costs a few
characters, because a model that copies a line into `read_file` must get a path
that works — an indented bare name is the sort of thing that produces
`Coding/2026-08-12.md` and a not-found error.

## 3. OBS-5 — `outline`, `read_section`, `write_section`

### Resolution: Obsidian's own, not ours

`resolveSubpath(cache, '#Chunking')` returns `{ start: Loc, end: Loc | null }`
with character offsets, and for a heading it ends the section at the next heading
of the same or higher level — so a section includes its subsections, which is
what anyone means by "grab the section". It handles `#^blockid` and nested
`#Parent#Child` disambiguation for free. Writing our own heading scanner would be
a second definition of "section" that drifts from the one Obsidian uses to render
`[[note#heading]]`, and it would silently disagree with the inliner. So:

```ts
/** The byte range of `subpath` ("#Heading", "#^block") within `file`, or null. */
export function sectionRange(app: App, file: TFile, subpath: string):
  { start: number; end: number; label: string } | null;
```

`end` falls back to the file length when `resolveSubpath` reports `null` (the
last section of a note). `label` is what the section is called, for the "inlined
from" line and for `read_section`'s header.

Both `read_section` and `write_section` accept the heading two ways — `{path,
heading}` and a combined `{path: "Notes/Ideas.md#Chunking"}` — because models
write both and neither is wrong. A `#` in the path argument is split off before
`findNote` sees it.

Not found is answered the way `paths.ts` answers a missing file: with the near
misses named. `Error: no heading "Chunkng" in Notes/Ideas.md. Headings: Chunking,
Overlap, Cost.` — the retry then costs one round instead of an `outline` call
plus a guess.

### `outline`

Heading tree, frontmatter *keys*, and counts, from `getFileCache` alone:

```
Notes/Ideas.md — 412 lines, 9 headings, 14 links, 3 tags
frontmatter: created, tags, status
# Ideas
  ## Chunking            (lines 12–58)
  ## Overlap             (lines 59–104)
    ### Cost             (lines 78–104)
```

Frontmatter values are deliberately left out: a `description:` field can be a
paragraph, and `outline` exists precisely to not carry prose. Line ranges are
included because they make the tool composable — a model can see that Chunking is
46 lines before deciding whether to pull it.

### `write_section`, and why it is not optional

`read_section` on its own makes the vault *more* dangerous. Today a model that
edits a long note must read all of it, so whatever it writes back is at least
informed by the whole thing. Give it a cheap way to read one heading and the
`write_file` tool it already has, and the plausible next move is to rewrite the
note from the one section it read — deleting the rest. So the pair ships together
or neither does.

```ts
{ path, heading, content, mode?: 'replace' | 'append' }  // default replace
```

It resolves the same range, splices the string, and hands the result to the
existing `writeFile` — so it inherits `ensureWritable`, the approval card, and
the diff the panel shows, with no new permission path. `append` inserts at the
end of the *section* (before the next heading), not the end of the file; that
distinction is the whole reason the tool exists and it is what the acceptance
run checks.

The heading line itself is never replaced, only the body under it. A model asked
to rename a heading must use `write_file`; letting `write_section` rewrite its
own anchor is a good way to lose the rest of the note to an off-by-one.

## 4. OBS-7 — `tags`

```ts
{ tag?: string; limit?: number }
```

No argument: every tag with a count, from `getAllTags(getFileCache(f))` over
readable markdown files, sorted by count then name. With a tag (leading `#`
optional, matched case-insensitively, and `#project` also matching
`#project/active` because Obsidian's tag hierarchy is a prefix): the notes
carrying it.

`getAllTags` is the reason this is not written by hand — it merges inline tags
and the `tags:` frontmatter field, including the several shapes that field takes
(a list, a string, a comma-separated string), which is exactly the parsing nobody
should write twice.

No file contents are read at all. On a large vault this is the cheapest tool in
the set.

## 5. OBS-4 — `create_folder`

`ensureFolder(app, path)` moved into `src/tools/files.ts`, plus a permission
check. Creating a folder is not a content write, so there is no diff to show; it
does still put a new directory in the user's vault, which is what the write scope
exists to govern. So it is gated like a write, with a new approval kind (§6.2).

Creating a folder that exists succeeds quietly and says so — `ensureFolder`
already swallows the create race, and a model that calls `create_folder` before
`write_file` should not be punished for being careful.

Its approval card offers Deny / Allow once / Allow for session / `Always: <parent>/`
and no "Always: this file" — there is no file, and a grant on a folder path is
what a user creating a tree actually wants anyway.

## 6. OBS-3 — `move_file`

### The API

`app.fileManager.renameFile(file, newPath)` — not `vault.rename`, which the
typings explicitly warn moves the file *without* updating links. `renameFile`
takes a `TAbstractFile`, so the same call moves a folder and everything under it.
It has been public since 0.11; `minAppVersion` is 1.7.2, so the lint rule that
checks `@since` against the manifest is satisfied.

```ts
{ path: string; to: string }
```

`to` is resolved with a rule that has to be stated because both readings are
common: **if `to` names an existing folder, the file moves into it keeping its
name; otherwise `to` is the new full path**. A `to` with no extension, moving a
`.md` file, gains `.md`. This is the one piece of guesswork in the tool, so the
result line always says where the file actually went.

### Permissions

A move is a delete at one end and a create at the other, so it needs write
permission at **both**. `isWritable(source)` and `isWritable(destination)`, and if
either fails, one approval card covering the whole move — not two.

Sources that fail `isReadable` cannot be moved, which falls out for free:
`findNote` never matches or suggests a blocked file, so the tool cannot be handed
one. Folders need the check written explicitly: **a folder containing any
unreadable file is refused**, with the reason given. Without that rule, moving a
blocked folder into a readable one is an exfiltration path — the agent could not
read `Private/` but could move it to `Public/` and read it there. That is the
security-relevant line in this change and it gets a comment saying so.

### Approval kinds

`ApprovalRequest.kind` is `'write' | 'mcp'` today, and the write branch of the
card renders a before/after diff. A move has no diff, and a folder creation has
no content at all; feeding either through the write branch would draw a
whole-file deletion that is not happening. So `kind` gains `'move'` and
`'create-folder'`, and `ApprovalRequest` gains an optional `toPath`:

```
🛡 Approval required
The agent wants to move a file outside your allowed folders (via move_file):
  Notes/Ideas.md  →  Archive/2026/Ideas.md
[Deny] [Allow once] [Allow for session] [Always: this file] [Always: Archive/2026/]
```

The four grant results keep their existing meanings; `always-folder` grants the
destination's parent, which is the one a user reorganising a vault actually wants.

Rejected: a single generic `kind: 'path'` carrying a verb string. It collapses
two card layouts into one at the cost of a discriminator inside a discriminator,
and there are exactly two of them.

### Verifying that the links followed

This is what makes the answer to the user's question true rather than hopeful.
Before the move, count the notes linking to the source by inverting
`metadataCache.resolvedLinks` (`buildBacklinks` in `tools/graph.ts` already does
this — it becomes exported). After the move, wait for the cache to settle and
count again at the new path.

Settling matters: `resolvedLinks` is rebuilt asynchronously after a rename, so
counting immediately reports the old world. `metadataCache.on('resolved')` fires
when every file has been re-resolved; the tool awaits one, with a 3-second
timeout so a busy vault degrades to "could not confirm" instead of hanging the
turn.

```
Moved Notes/Ideas.md → Archive/2026/Ideas.md. 6 notes linked to it; all 6 now
point at the new path.
```

or, when the vault has link updating switched off:

```
Moved Notes/Ideas.md → Archive/2026/Ideas.md. 6 notes linked to it and 6 still
point at the old path — Obsidian's "Automatically update internal links" is off
in this vault, so nothing was rewritten. Those links are now broken: Notes/A.md,
Notes/B.md, … Fix them with write_file, or ask the user to turn the setting on.
```

A model that gets that back can tell the user the truth without knowing anything
about Obsidian in advance.

### The open conversation

If the agent moves the note that is the panel's current transcript,
`ChatView.conversationPath` goes stale and the next save writes a second file at
the old path. The panel already has to care about renames, so it registers
`vault.on('rename')` and follows the path. Five lines, and without them
acceptance test 15 fails in a way that quietly duplicates the user's history.

The RAG index needs nothing: `main.ts` already wires `vault.on('rename')` to
`rag.rename`, so a move re-keys the vectors on its own.

A move does not report an `onFileChange`: `FileChange` is a content diff
(`create` | `update`, before/after text) and a move changes no content, so a
green/red diff of the whole note would be a lie. The panel shows the tool call
and its result line, which names both paths and what happened to the links —
which is the more informative record here.

## 7. OBS-1 — `capabilities`

### Generated, never written down

A hand-written capability blurb is a lie with a delay on it. So the report is
built at call time from the same sources the behaviour comes from:

```ts
export function describeCapabilities(
  app: App,
  settings: VaultAssistantSettings,
  offered: Set<string>,   // the tools THIS request actually got
): Promise<string>;
```

`offered` is the set `runAgent` already computes and threads into `executeTool`
for alias redirection — so the report cannot claim a tool a workflow step's
allowlist removed, and cannot omit an MCP tool that is present. Scopes come from
`permissions.ts`, not from a copy of the settings values. Sections:

1. **Tools you have right now** — grouped by purpose rather than listed flat
   (look around · read · search · write · move · knowledge · introspect), because
   twenty names in one list is where tool choice starts degrading. Each of the
   handful whose behaviour is surprising gets one line; the rest are just named,
   since their specs are already in front of the model.
2. **Tools you do not have, and why** — `semantic_search` when `useRag` is off,
   `open_files` when `useOpenFiles` is off, each naming the setting that would
   turn it on, so the model can tell the user how to get the thing they asked for.
3. **What you may touch** — read scope and how many folders are blocked (not
   which: naming a blocked folder leaks the thing the blocklist hides), the
   writable folders, and what happens outside them (the approval card, and that
   in an autonomous workflow run it is auto-denied instead of shown).
4. **How Obsidian behaves** — link updating on move (below), that `[[links]]`
   resolve by name and not by path so a link survives a move, that a link into a
   moved-away note appears in `links` as unresolved.
5. **What you cannot do here** — no shell, no network, no filesystem outside the
   vault, no delete, no copy, no running Obsidian commands, no editing the open
   editor buffer (writes go to disk and Obsidian reloads the view). Plus
   desktop-or-mobile from `Platform.isDesktopApp`, which decides whether stdio
   MCP servers can exist at all.

### Reading Obsidian's link-update setting

The setting is **Settings → Files & links → Automatically update internal
links**, stored as `alwaysUpdateLinks` in `<configDir>/app.json`. There is no
public API for it: `Vault.getConfig` is real but undocumented and untyped.

The plan reads the file instead, through public API only —
`app.vault.adapter.read(normalizePath(app.vault.configDir + '/app.json'))`,
`JSON.parse`, look for `alwaysUpdateLinks`. Obsidian writes only non-default keys
there, so **absent means on** (the shipped default). Any failure — no file,
malformed JSON, an adapter that refuses — degrades to "Obsidian's setting decides
and I could not read it; `move_file` reports afterwards whether the links
actually followed", which is still a useful answer.

Rejected: `(app.vault as any).getConfig('alwaysUpdateLinks')`. One line instead
of eight, but it is an internal API in a plugin that intends to be listed in the
community catalogue, and it needs an `any` cast in a codebase that is
`strict: true` throughout. The config file is the user's own Obsidian settings
inside their own vault, read locally, and the only thing that ever leaves is the
word "on" or "off" inside a tool result — no note content, no new egress.

Read fresh on each call rather than cached: the report is called rarely, the file
is a few hundred bytes, and a cached answer would be wrong for the rest of the
session the moment the user flips the setting — which is exactly what acceptance
test 1 does.

### Making the model call it

One line in the `--- How you reach this vault ---` block of `buildSystemPrompt`:

> Before telling the user what you can or cannot do — or how Obsidian will react
> to something you are about to do — call `capabilities`. It answers from this
> vault's live settings. Do not guess.

Not the whole report injected at session start: it is 1–2 KB that most
conversations never need, and this codebase's established shape is to inject a
pointer and load lazily (the wiki injects Home's table of contents, not the
wiki). Same reasoning, same pattern.

## 8. OBS-2 — Resolving the `[[links]]` you type

### The parser

`src/wikilinks.ts`, no model call, never throws:

```ts
export interface Inlined { link: string; path: string; label: string; text: string; }
export interface Expansion { block: string; inlined: Inlined[]; skipped: string[]; }

export function expandWikilinks(app, settings, message, sourcePath): Expansion;
```

1. Match `![[…]]` and `[[…]]` across the message, ignoring anything inside a
   fenced code block (a message *about* wikilink syntax must not trigger it).
2. Split each on `|` (alias, discarded) and the first `#` (subpath, kept).
3. Resolve the note with `metadataCache.getFirstLinkpathDest(linkpath, sourcePath)`
   — Obsidian's own resolution, so shortest-path links, aliases and relative
   links all behave the way they do in a note. `sourcePath` is the focused note's
   path when there is one, else `''`; a link typed in the chat box while looking
   at a note should resolve the way it would in that note. When **See what you
   have open** is off, `sourcePath` is `''` — that setting means the panel does
   not use what you have open, and quietly using it for link resolution would
   route around it.
4. Drop anything failing `isReadable`, recording it as skipped.
5. Slice: whole file, or `sectionRange` from §3 for a subpath.
6. Deduplicate by resolved path + subpath.

### The block, and where it goes

Appended to the user's message, after the text they typed:

```
--- inlined from Notes/Ideas.md#Chunking (heading section, 1,240 chars) ---
…the section text…
--- end inlined ---
```

A fenced marker rather than a `> [!quote]` callout, because a callout prefixes
every line with `>` and mangles any code block inside the note. Plain delimiter
lines survive arbitrary content, including nested ``` fences, and are trivially
strippable by the two parsers that need to strip them (§8.3).

**Appended, not spliced at the link's position.** "Compare [[A]] with [[B]]" with
two notes spliced mid-sentence is unreadable for a person and worse for a small
model; the sentence stops being a sentence. The link stays where it was written
and the material arrives underneath it, which is how a person would attach it.

**Into the message, not into the system prompt.** The pre-pass and open-files
blocks live in the system prompt and are stripped and rebuilt every turn — right
for them, since both describe *now*. Wrong here: a note you pulled in on turn one
and discussed for five turns would vanish after the first. It also has to be in
the message for the transcript to be honest — `parseConversation` rebuilds
history from the saved file when a conversation is reopened, so anything not in
the message is context that silently disappears when you come back to a chat.

Budget: 4,000 characters per link, 12,000 per message. Over budget, what fits is
inlined and the rest is named — `(also linked, not inlined: [[X]], [[Y]] — read
them with read_file)`. This is also what handles "here is a list of twelve links"
gracefully, without a magic rule about how many links means the user meant them
as text.

### The two parsers that must learn about the fence

**`parseConversation`** (`src/conversation.ts`) splits a transcript on lines
starting `## 🧑 You` / `## 🤖 Assistant`. Inline a saved conversation — entirely
plausible, they are notes like any other — and those markers appear inside the
inlined text, and reopening the transcript shatters one turn into several. Fix
the parser, not the content: track whether the line is inside an
`--- inlined from … ---` fence and ignore markers there. Escaping the content
instead was rejected — it corrupts what the model reads to protect a parser.

**`chunkConversation`** (`src/rag/chunk.ts`) embeds user turns for semantic
search. Inlined text is a copy of a note that is already indexed, so embedding it
would return the same passage twice under two paths. It skips fenced regions, the
same way it already skips `> 🔧` tool lines. Same fence-tracking helper, exported
once and used by both.

### Setting and visibility

`expandTypedLinks: boolean`, default **true**, as **Expand `[[links]]` you
type** — "Resolve `[[note]]` and `[[note#section]]` in your message and attach
the text before sending, so you don't spend a tool round on it. Contents of
blocked folders are never attached."

Default on because a wikilink typed into a chat box is already an unambiguous
"this note, please"; and the panel makes it visible rather than silent — a line
under the user's bubble reading `↘ inlined Notes/Ideas.md#Chunking · Notes/Cost.md
(2.1k)`, and, when something was skipped, `↘ 1 link is in a blocked folder — not
attached`.

Privacy: this sends note contents to the model endpoint without the model asking
for them. It is user-initiated (you typed the link) and it respects the read
blocklist, but it is a new path by which vault content leaves, so it goes in the
README privacy section and in the AGENTS.md egress paragraph, which enumerates
exactly these.

## 9. OBS-8 — The alias table

In `src/tools/aliases.ts`, `UNSUPPORTED` currently contains `move_file`, `move`,
`mv`, `rename_file`, `rename`, `mkdir`, `create_directory`, `create_folder` and
answers all of them with "this plugin cannot delete, move, copy or rename files.
Tell the user what you would like changed and let them do it in Obsidian." After
§5 and §6 that message is false, and a confidently wrong correction is worse than
none — it is what produced the dummy-note folder creation in the first place.

The move and folder names go into `WRITE_ALIASES`, redirecting to `move_file`
(arguments `path`, `to`) and `create_folder` (argument `path`). `UNSUPPORTED`
keeps `delete_file`, `delete`, `rm`, `remove_file`, `unlink`, `copy_file` and
`cp`, and its message is narrowed to what is actually true: this plugin cannot
delete or copy files; it *can* move, rename and create folders, and here are
those tools. `READ_ALIASES` gains `head`/`tail`/`sed` → `read_file`, `tree` →
`list_files`, and `find` → `search`, which are the remaining shell names a coding
model reaches for.

New argument aliases in `ARG_ALIASES`: `destination`, `new_path`, `target`,
`to_path` → `to`; `section`, `header` → `heading`.

## 10. Order of work

Each phase is independently landable and independently judgeable.

1. **§2 search + list_files.** No new data flow. Lands alone.
2. **§3 sections** (all three together) and **§4 tags**. Pure additions over
   `metadataCache`.
3. **§5 create_folder** and **§6 move_file**, with the `ApprovalRequest` kinds,
   the folder-readability rule, the link verification, and the panel's rename
   listener. This is the phase that touches the permission model.
4. **§9 aliases.** Immediately after phase 3, so the table is never describing a
   vault that no longer exists. Small enough to fold into phase 3's commit if it
   reads better there.
5. **§7 capabilities.** After the tools exist, so the report is written once
   against the final set instead of twice.
6. **§8 typed links.** Last: it is the only change that touches the send path,
   the transcript format and the RAG chunker, and it benefits from the section
   helpers in phase 2 being settled.

`README.md` is updated as each phase lands, not at the end — feature bullets, the
settings table row for the inliner, the privacy paragraph, and the vault-tools
list. `AGENTS.md`'s network-egress paragraph is updated in phase 6. When the last
phase is accepted, `docs/_planning/obsidian-integration/` is deleted: the README
carries what is durable and git history carries the rest.

## 11. Risks

**Twenty tools is a lot for a small model.** This is the main risk and it is
not hypothetical: the context pre-pass exists in this plugin *because* small
local models flail at tool selection, and this change grows the built-in set from
13 to 20 before any MCP server is connected. Mitigations in the design: names
stay verb-shaped and distinct, `capabilities` groups them by purpose rather than
listing them flat, and the tools that most often replace a bad choice
(`read_section` instead of `read_file`, a scoped `search`) are strictly cheaper
than what they replace. If acceptance test 26 fails, the fallback is a settings
toggle that offers the section and structure tools only when asked for — but that
is a knob nobody has asked for yet, so it is not in this change (principle 2).

**`resolveSubpath` needs the metadata cache.** A note written seconds ago may not
be parsed yet, so `read_section` on it returns "no headings cached for this note
yet — read_file it". Rare, self-correcting, and worth one line of handling rather
than a retry loop.

**Regex over a large vault.** Bounded by per-line matching, a 200-character
pattern limit, the `path` scope, and the existing per-file `await`. Not bounded
against a deliberately pathological pattern on a huge vault; the honest position
is that this is the same exposure `search` has today with a slower inner loop,
and the panel's Stop button already exists.

**The `alwaysUpdateLinks` default.** The design asserts that an absent key means
on. If Obsidian ever changes that default, `capabilities` reports the opposite of
the truth for users who never touched the setting. The mitigation is that
`move_file` verifies empirically and its result overrides the report — the
guessy path is the *prediction*, and the *observation* is always right.

**Budget numbers in §8 are picked, not measured.** 4,000/12,000 characters is
roughly one long note and roughly 3k tokens. If they are wrong, they are one
constant each.

## 12. Considered and rejected

Recorded so the next change argues with this rather than rediscovering it.

- **Delete / trash** (`FileManager.trashFile`, one line, respects the user's
  trash preference). Out: irreversible, unasked for, and the file explorer is
  right there. If it is ever added it should report what it moved to trash and
  where trash is, the way `move_file` reports links.
- **Copy / duplicate.** No demonstrated need.
- **General patch editing** — line ranges, string replacement, unified diffs.
  `write_section` covers the case that motivated this (a long note edited in one
  place) using an anchor Obsidian already defines. Patch application needs its
  own ambiguity handling and its own failure modes; it is a subsystem, not a tool.
- **A frontmatter tool** over `FileManager.processFrontMatter`. Genuinely
  attractive: it edits properties without a whole-file rewrite and cannot mangle
  YAML, which whole-file writes by small models absolutely can. The strongest
  candidate for the next change, and out of this one only to keep it bounded.
- **Open / reveal a note in Obsidian** (`workspace.getLeaf().openFile`). The
  first tool that would let the agent act on the *interface* rather than the
  vault, which is a new category with no permission analogue in the current
  model. Deserves its own thinking.
- **A vault-wide broken-link report.** `list_wiki` already does this for the wiki
  and `links` does it per note; vault-wide is a maintenance feature that wants a
  UI, not a tool result.
- **Recently-modified notes** (`TFile.stat.mtime`, no file reads, answers "what
  have I been working on"). Cheap and good. Left out only because nothing in the
  request needs it; first candidate if the acceptance run shows the agent
  fumbling for orientation.
- **Daily-note integration.** Needs either a dependency or an internal API, and
  the vault path is usually already in operating memory.
- **Injecting the capability report at session start** rather than behind a tool.
  1–2 KB on every conversation for something most never need, against this
  codebase's consistent pattern of a pointer plus lazy loading.
- **Splicing inlined notes at the link's position** rather than appending. §8.2.
- **A separate `grep` tool** beside `search`. §2.1.
- **`Vault.getConfig` for `alwaysUpdateLinks`.** §7.2.

---

Requirements: [requirements.md](requirements.md) · Repository README: [../../../README.md](../../../README.md)
