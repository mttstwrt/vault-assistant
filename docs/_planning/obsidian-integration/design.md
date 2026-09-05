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

## 1. Where the code goes, and what it defers to

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

### Deferring to Obsidian: the audit

The rule for this change is that if Obsidian already has a function for
something, that function wins — it is how compatibility with the app's own
settings, link formats and file handling comes for free rather than being
re-derived and then drifting. Applied honestly, that rule finds three places
where the *existing* code does not defer and should, so they are folded in here
rather than left as known-wrong:

**`Vault.process(file, fn)`** (@since 1.1.0) is an atomic read-modify-write.
`append_file` today reads the file, concatenates, and writes — two awaits apart,
so an edit the user makes in the note between them is silently discarded.
`update_wiki` in append mode and `remember` in append mode have the same shape,
and `write_section` (§3) would have added a fourth. All four move to `process`,
whose callback computes the new text from the text Obsidian holds at write time.
This is a real bug fix riding along, not a refactor: the failure it removes is
"the agent ate my paragraph".

**`metadataCache.getFirstLinkpathDest(name, '')`** is Obsidian's own answer to
"which note is called X", including frontmatter aliases and the user's link
resolution settings. `paths.ts` currently ends its fallback chain with a
hand-rolled scan comparing lowercased basenames, which misses aliases entirely
and can disagree with what the same string would resolve to inside a note. The
hand-rolled scan stays as the last resort (it powers the "closest matches"
suggestions), but Obsidian's resolution is tried first.

**`fileManager.generateMarkdownLink(file, sourcePath)`** renders a link in the
format the user has chosen — wikilink or markdown, shortest path or relative or
absolute. The system prompt currently instructs the agent to write `[[wikilinks]]`
by hand, which produces links a user who turned **Use [[Wikilinks]]** off has
explicitly said they do not want. The wiki tools should generate links through
this instead of by string concatenation. (Scoped to where the plugin *writes*
links; reading them is already Obsidian's job via `resolvedLinks`.)

Two places where the rule does not apply, recorded so they are not re-litigated:

- **There is no public search API.** Obsidian's own search lives in the
  `global-search` internal plugin, which is not public API. §2 is hand-rolled
  because there is nothing to defer to, not by preference.
- **`ensureFolder` keeps its loop.** `Vault.createFolder` is documented to throw
  if the folder exists and says nothing about creating missing parents, so the
  level-by-level loop that swallows the exists-error is the correct use of it,
  not a workaround for it.

And one open question, at §7.2: `Vault.getConfig('alwaysUpdateLinks')` *is*
Obsidian's own function — it is simply undocumented and untyped. The design
currently reads the config file through public API instead. Under a
defer-to-Obsidian-wherever-possible rule that call is arguably the right one;
the argument against is community-catalogue review of internal API use.

One version note, since this change reaches for newer APIs than the code has so
far: `manifest.json` sets `minAppVersion: 1.7.2`, and `eslint-plugin-obsidianmd`
fails the build on any API newer than that. Everything above clears it —
`renameFile` 0.11, `process` 1.1, `createFolder` 1.4, `trashFile` 1.6.6 — but
`Vault.copy` is 1.8.7, which is one more reason copy is a non-goal rather than a
freebie.

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
  case_sensitive?: boolean; // default false           (grep -i, inverted)
  whole_word?: boolean;     // default false           (grep -w)
  invert?: boolean;         // lines that do NOT match (grep -v)
  context?: number;         // lines either side, 0–3  (grep -C)
  multiline?: boolean;      // match across lines rather than line by line
  files_only?: boolean;     // paths only              (rg -l)
  limit?: number;           // max hits overall (default 20, max 100)
  max_per_file?: number;    // default 3
}
```

The option list is deliberately grep's, because grep's is the one every model
already knows and because those flags are what "comprehensive search options"
actually means in practice — the regular-expression *engine* is not the gap
(§12 argues this at length). `-i`, `-w`, `-v`, `-C` and `-l` are a few lines
each on top of the scan; `multiline` is the one that genuinely changes the loop,
so it gets its own branch that runs the pattern over the whole file text and
reports the line number of each match's start.

Output becomes grep-shaped, which is the shape every model already knows:

```
Notes/Chunking.md:14: the overlap carried between adjacent chunks
Notes/Chunking.md:41: chunk overlap is 200 characters
Notes/Embedding.md:7: overlap matters more than chunk size here
3 matches in 2 files.
```

Matching is per line by default, not per file: the line is the unit that gets a
number, the unit that gets reported, and — usefully — the unit a regular
expression runs against, which bounds how much text any single `RegExp.exec` can
backtrack over. `multiline: true` gives that bound up deliberately and is
documented as the slower mode.

A pattern longer than 200 characters is refused; a pattern that will not compile
comes back as `Error: "…" is not a valid regular expression: …` rather than
throwing out of the tool. That path also covers a real platform difference:
lookbehind (`(?<=…)`) throws on iOS before 16.4, which is why
`eslint-plugin-obsidianmd` bans it in source for any plugin that is not
`isDesktopOnly`. A model-supplied pattern cannot be linted, so on those devices
a lookbehind pattern simply fails to compile and the model is told the pattern is
not supported here — the same route as any other bad pattern.

The scan is still `cachedRead` over `getMarkdownFiles()` filtered by `isReadable`,
with the `path` prefix applied first so a scoped search does not read the vault,
and the early exit on `limit` kept. `cachedRead` is the right call here and the
`await` on each file is what keeps the panel responsive across a large vault.

`literalSearch` in `src/prepass.ts` is a copy of the current implementation, kept
because the pre-pass needed the same scan and there was nowhere shared to put it.
Now there is: it calls the new module and the copy is deleted. Its caller wants a
plain snippet list rather than line-numbered hits, so the module exports the scan
and the two callers format it — one shape of the search, two renderings.

### Why not shell out to real grep or ripgrep

Considered seriously, because grep's option surface is decades deeper than
anything worth writing here, and rejected on four counts that are about the
plugin rather than about grep.

**It does not exist on most of the platforms this plugin targets.**
`manifest.json` says `isDesktopOnly: false`: this runs on iOS and Android, where
there is no shell and no `child_process` at all. Stock Windows has no `grep`
either — `findstr` is a different tool with different syntax — and ripgrep is not
installed by default on macOS or on any mainstream Linux distribution. So a
shell-backed search would work on macOS and Linux desktops and nowhere else,
which would make the agent's abilities depend on the device it happens to be
running on. That is the exact thing OBS-1 exists to eliminate; `capabilities`
would end up reporting a search tool that half the users cannot have.

**It moves the privacy boundary from one function into argument construction.**
Right now every path in this plugin passes `isReadable(path, settings)` — one
function, one place, and the read blocklist is enforced identically for every
tool. Handing the job to grep means translating that blocklist into
`--exclude-dir` / `--glob '!…'` arguments and getting the quoting right for
arbitrary user folder names, plus excluding `.obsidian/`, `.trash/`, the plugin's
own `rag-index.json`, and every binary attachment in the vault. A mistake there
leaks the contents of a folder the user explicitly hid. That is the one class of
bug this design is least willing to risk, and argv is a much weaker place to
enforce it than a function call.

**It adds a process-execution surface to a plugin heading for the community
catalogue.** Done correctly it is `execFile` with an argument array and never a
shell, so injection from a model-supplied pattern is preventable — but "executes
external commands" is a thing plugin review looks hard at, and AGENTS.md's
security section asks for the minimum necessary scope.

**Speed is not the motivation.** A large personal vault is single-digit to
low-tens of megabytes of markdown, much of it already in Obsidian's read cache;
process spawn costs 10–30 ms before anything is read. ripgrep wins decisively on
a ten-gigabyte monorepo, which is not what is being searched here. Principle 3
says not to trade clarity for unmeasured speed, and there is no measurement
pointing this way.

What is actually lost by staying in-process is *options*, not engine power — JS
`RegExp` has lookahead, backreferences, named groups and unicode property escapes;
what it lacks against `rg` is `-A/-B/-C`, `-w`, `-v`, `--multiline` and friends,
and those are a few lines of our own code each. So they are simply implemented,
above.

**If real ripgrep is wanted anyway, the architecture already has the right slot
for it, and it is not this tool.** The plugin is an MCP client with a server
allowlist, a trust flag and an approval card. A filesystem/ripgrep MCP server is
a user-installed, separately-disclosed, individually-approvable component that
gets full rg without putting `child_process` into the plugin or moving the
blocklist into argv. That keeps the built-in tool honest about what it is (a
portable, always-available search) and lets the desktop user who wants rg have
exactly rg.

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

### Autocomplete, and why it is not in this change

Obsidian's link autocomplete — the popover that appears when you type `[[` in a
note — is an `EditorSuggest`, registered with `registerEditorSuggest` and driven
by the CodeMirror editor's cursor. It runs inside a markdown editor and nowhere
else. The chat composer is a plain `<textarea>` (`chat-view.ts:223`), so
Obsidian's own suggester will not appear in it and cannot be made to.

The sanctioned way to attach a suggester to something outside the editor is
`AbstractInputSuggest`, which the lint plugin actively pushes plugins toward. Its
constructor signature is the obstacle:

```ts
constructor(app: App, textInputEl: HTMLInputElement | HTMLDivElement);
```

A `<textarea>` is neither. Casting one through is tempting and is rejected on the
same grounds as `Vault.getConfig` in §7.2, only more so: the class accepts a
contenteditable `<div>` *or* an `<input>`, so its implementation must branch on
which it got, and a textarea landing in the contenteditable branch would read
`textContent` where it should read `value`. That is a cast whose safety depends
on implementation details we cannot see, which is a worse bet than one whose
behaviour is at least well known.

There are two honest routes to a real suggester, and both are their own change:
switch the composer to a contenteditable `<div>` (supported by the constructor,
but `fitToContent`, `.value`, Enter-to-send, placeholder and paste-as-plain-text
all touch the textarea today), or write a small suggester of our own (~120 lines
of positioned popover and keyboard navigation; the lint rule only objects to the
specific copied `createPopper` implementation, not to the idea).

What *is* in this change is the cheap 80%: because the pre-parser resolves every
link anyway, a link that resolves to nothing is already known, and the panel says
so with the near-miss naming `paths.ts` already computes —

```
↘ inlined Notes/Chunking.md · [[Overlp]] matched no note — did you mean Notes/Overlap.md?
```

That closes the loop a suggester would have closed, one step later and for
roughly five lines. Suggestions are listed as a follow-up in §12; the near-miss
line is what makes it a nicety rather than a gap.

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

0. **A tool-selection baseline.** Before adding anything: the ~12-prompt harness
   from §11, run against the current 13 tools on both target models, so the
   number this change is judged against exists before the change does. Cheap, and
   without it "did the tool list get too long" stays an opinion.
1. **§2 search + list_files**, and the `getFirstLinkpathDest` fallback from §1.
   No new data flow. Lands alone.
2. **§3 sections** (all three together) and **§4 tags**. Pure additions over
   `metadataCache`. The move of `append_file`, `remember` and `update_wiki` onto
   `Vault.process` (§1) rides here, since `write_section` is written against it
   anyway.
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

**Twenty tools, and what that actually costs.** The first draft of this section
said "small models flail at tool selection" and left it there, which conflated
two different things. Separating them:

*Parameter count is the weaker factor.* The pre-pass was built for the 3–8B
class, where tool selection genuinely degrades with a long list. At 27–32B —
Gemma 3 27B and Qwen3 32B, the models this vault is actually driven with — a
twenty-tool list is well inside what the class handles. The sharp degradation
people report tends to start much further out, in the 40–60+ range, and it is
usually overlapping tool *descriptions* rather than the count that causes it.

*Tool-calling training is the stronger factor, and the two models differ.*
Qwen3 ships explicit tool-call training and a tool-call section in its chat
template, so an OpenAI-compatible endpoint emits structured calls natively.
Gemma 3 does not ship native tool-call tokens; function calling with it is
prompt-shaped — the schemas go in the prompt and JSON is parsed back out of the
content — which llama.cpp handles with a generic fallback format. The same
twenty tools will therefore behave noticeably differently between the two, and
Gemma is the one to watch. (State of the art moves; check what `--jinja` reports
for the template actually in use rather than trusting this paragraph.)

*Context cost is concrete and measurable, and is arguably the real price.* The
current 13 specs serialize to ~5.7k characters, about 1.6k tokens, plus the
per-tool wrapper the OpenAI wire format adds — call it 1.7k. Seven more of
similar length puts it near 2.5k. On a 32k window, that is a rise from roughly
5% to roughly 8%, spent on every single request whether or not the conversation
needs any of it. It sits in the cached prefix so it costs little *time*, but the
space is gone. The panel's context ring already makes this visible.

Mitigations, in order of leverage:

1. **Disjoint descriptions with explicit cross-references** — "use `read_section`
   rather than `read_file` when you already know the heading". Description
   quality beats count, which is also the reasoning behind §2.1's refusal to ship
   `grep` beside `search`.
2. **Constrained decoding.** llama.cpp with `--jinja` and a model whose template
   declares tools will constrain tool-call output with a grammar, which removes
   malformed-call failures rather than reducing them. This is a documentation and
   settings matter, not code, and it is exactly what a Gemma-class template
   without a tool section cannot give you — worth a README troubleshooting entry
   alongside the repetition-penalty one.
3. **Trimming already exists.** `activeToolSpecs` drops tools by setting, and
   workflow steps already take a `tools` allowlist. If a group toggle is ever
   needed, the machinery is there; building it now would be a knob ahead of its
   evidence (principle 2).

And rather than argue about it — **measure it (phase 0, §10)**. A fixed set of
~12 prompts with a known-correct first tool call, run at 13 tools and at 20
against both models, scoring first-call accuracy and rounds-to-answer. It is an
afternoon's work, it turns this risk into a number, and it is reusable for every
future tool addition instead of being spent once. If it comes back bad, the
answer it gives also says *which* tools are being confused, which a toggle
designed in advance would only have guessed at.

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
- **Shelling out to real grep or ripgrep.** §2.3 — the short version is mobile
  and Windows have neither, and the read blocklist is safer as a function call
  than as `--exclude-dir` arguments. An MCP filesystem/ripgrep server is the
  supported way to have the real thing.
- **Link autocomplete in the chat composer.** §8.4 — Obsidian's own suggester is
  editor-only and `AbstractInputSuggest` will not take a `<textarea>`. Worth
  doing as its own change; the near-miss line covers most of the value meanwhile.
- **`Vault.getConfig` for `alwaysUpdateLinks`.** §7.2, and re-opened in §1's
  audit — under a strict defer-to-Obsidian rule this one is genuinely arguable.
- **`Vault.copy`.** Not just unwanted (copy is a non-goal) but @since 1.8.7,
  above this plugin's `minAppVersion` of 1.7.2, so the lint rule would reject it.

---

Requirements: [requirements.md](requirements.md) · Repository README: [../../../README.md](../../../README.md)
