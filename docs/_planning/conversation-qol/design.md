# Design: conversation and settings quality-of-life

**Status:** Draft for review · **Date:** 2026-08-30
Requirements: [requirements.md](requirements.md)

## 0. Summary

One header button, one CSS rule with a class beside it, and one extra line asked
of a model call that already happens.

The save button needs the panel's save logic to be callable from somewhere other
than the end of `send()`, so that logic moves into a method both callers share.
Filing needs the path that logic computes to be able to have a folder in it, so
`newConversationPath` takes one. Naming and filing are one question — *what is
this conversation, and where does it go* — so they are one call and one module;
`src/title.ts` becomes `src/filing.ts` and answers both. Everything else is
copy, a setting, and CSS.

## 1. QOL-2 — Settings inputs (do this one first)

It touches no behaviour, so it can land and be judged on its own.

### The mechanism

Obsidian lays a `Setting` out as a row: `.setting-item-info` (name +
description) on the left, `.setting-item-control` right-aligned. A text input in
that control keeps its default width whatever the row has spare, which is where
the squeeze comes from. Marking a row and stacking it is enough:

```css
/* Long values — URLs, vault paths, model names — need the row, not the corner
   a Setting's control column leaves them. Numbers and toggles are not marked:
   a full-width box for "0.7" reads as a mistake. */
.va-setting-wide {
	display: block;
}
.va-setting-wide .setting-item-control {
	justify-content: flex-start;
	width: 100%;
	padding-top: 6px;
}
.va-setting-wide .setting-item-control input,
.va-setting-wide .setting-item-control textarea {
	flex: 1 1 auto;
	width: 100%;
	min-width: 0;
}
```

`flex` rather than `width` alone because two rows pair an input with a button —
**Model** has the refresh-models button beside it — and the input should take
the row minus the button rather than push it off the end.

The class goes on with `Setting.setClass('va-setting-wide')`, which chains into
the existing builders with no restructuring:

```ts
new Setting(containerEl)
	.setClass('va-setting-wide')
	.setName('Conversations folder')
	.setDesc('Where chat transcripts are saved. Always writable.')
	.addText(…);
```

### Which rows get it

Every row whose value is a path, a URL, a name, or free text — 13 text rows and
the 6 textareas:

Base URL · API key · Model · Conversations folder · Wiki folder · Memory file ·
Home page title · Runs folder · Workflows folder · Goals note · Embedding model
· Embedding base URL · Embedding API key · Blocked-read folders · Writable
folders · Extra request parameters · Scheduled-run goal · Server definitions ·
System prompt.

Not marked, and unchanged: Temperature, Presence penalty, Repetition penalty,
Max tool steps, Default rounds per run, Default delay between rounds, Every
(hours), Results per search — every one of which holds a number of at most five
characters — and every toggle, dropdown and button row.

The textareas already carry `va-wide-textarea` (`width: 100%`), which only ever
filled the control column; stacking is what actually gives them the row. That
class stays, because `workflow-modal.ts` uses it outside a `Setting`.

### Alternatives

- **One rule on the settings container, opting *out* the numbers.** Fewer call
  sites (8 rather than 19), but it can only widen inside the row — stacking
  every row would restack the toggles too, and telling the two apart in CSS
  needs `:has()`, whose support depends on the Electron and mobile WebView
  versions Obsidian happens to ship. Rejected: a selector that might quietly
  not apply on a phone is worse than 19 explicit marks.
- **Widen in the row instead of stacking** (`input { width: 100% }` alone). Half
  the win for the same work; a row with a long description still leaves the box
  at about half the width.

## 2. QOL-1 — The save button

### Where the save logic lives now

`send()` ends with two blocks: one that computes `conversationPath` (making the
naming call) when auto-save is on and there is no path yet, and one that writes
— appending `history.slice(persistedCount)` for a reopened transcript, and
rewriting the whole file otherwise. Both are gated on
`settings.autoSaveConversations`, and both are inline.

They become one method:

```ts
/**
 * Write the conversation to its transcript, naming and filing it on the first
 * save. Shared by auto-save and the save button, so a conversation saved by
 * hand is the same file auto-save would have written. Returns the path, or
 * null when there was nothing to save.
 */
private async persistConversation(interrupted = false): Promise<string | null>
```

`send()` calls it where the two blocks were — before `setBusy(false)`, so the
naming call stays inside the busy window as it is today and a new message cannot
be sent while a path is being decided.

### What the button does

A `save` icon in the header, between **New chat** and **Open previous
conversation**, always visible. It is redundant while auto-save is on — nothing
is ever unsaved then — but a button that appears and disappears as a setting
changes is worse than a redundant one, and the conditional is code that buys
nothing.

```ts
private async saveNow(): Promise<void> {
	if (this.busy || this.saving) { this.busyNotice(); return; }
	if (this.history.length <= 1) { new Notice('Nothing to save yet.'); return; }
	this.saving = true;
	this.setStatus('Saving…');
	try {
		const path = await this.persistConversation();
		if (path) new Notice(`Saved to ${path}`);
	} finally {
		this.saving = false;
		this.setStatus(null);
	}
}
```

The header wraps (`flex-wrap: wrap`) and the model dropdown already shrinks to
make room, so a seventh control is affordable — but it is the last one that is:
anything further needs the header rethought rather than another icon added.

`saving` is a second flag rather than `setBusy(true)` because busy turns Send
into Stop, and there would be nothing to stop. `send()` checks it too, so a
message cannot be sent into a conversation whose path is still being decided —
otherwise two writers race on the same new file.

For a conversation with no path yet, `persistConversation` needs the opening
message the naming call takes. `send()` has it in hand; the button reads it back
out of history (the first `user` message), which for a chat saved at the end is
a better topic signal than the message just typed anyway.

### A saved conversation stays saved

The write is currently gated on `autoSaveConversations`; it becomes

```ts
if (this.plugin.settings.autoSaveConversations || this.conversationPath)
```

so that a conversation which *has* a file keeps it current. This is a departure
from the literal ask, and it is deliberate: the alternative is a file on disk
that looks like the conversation but stops three turns short, which is data loss
wearing the disguise of a backup. The setting keeps its meaning — it decides
whether a transcript is created *without being asked* — and the button's notice
says what it bought.

The same condition also makes a *reopened* transcript keep growing with
auto-save off. That is the same rule, honestly applied: the file exists, you
opened it deliberately, and the panel already told you it is "Continuing …".

### Two things that follow from it

The pop-out warning currently reads the setting; it should read the fact:

```ts
if (!this.conversationPath && this.history.length > 1) new Notice(…);
```

With a saved conversation the panel now *can* carry it to a new window (the path
travels in `getState`), so warning off the setting alone would be a lie. The
copy gains the fix: "Save it first to carry it across."

`persistedCount` keeps its meaning — how many history entries the file already
holds, non-zero only for a reopened transcript, which is what selects append
over rewrite. Manual saving does not change it, so repeated saves of a new
conversation rewrite the same file idempotently.

### Alternatives

- **A `save-conversation` command** for a hotkey. It is four lines and follows
  the `stop-response` pattern, but no header button except Stop has one; leaving
  it out keeps this round to what was asked, and it can be added the moment
  anyone wants to bind a key.
- **Hide the button when auto-save is on** — see above.
- **One-shot save** (later turns need another click). Simpler to describe,
  but leaves the truncated-transcript trap.

## 3. QOL-3 — Filing conversations into folders

### One call, two answers

`src/title.ts` becomes `src/filing.ts`: same cheap, tool-less call, now
answering both halves of the question. Its export:

```ts
export interface Filing { title: string; folder: string }

export async function suggestFiling(
	settings: VaultAssistantSettings,
	userMessage: string,
	assistantAnswer: string,
	want: { title: boolean; folders: string[] | null },
): Promise<Filing>;
```

`want.folders` is the list of folders that already exist (null = filing off).
The three shapes:

| naming | filing | prompt | reply |
| --- | --- | --- | --- |
| on | off | today's, unchanged | one line: the title |
| on | on | title + folder | `Title: …` / `Folder: …` |
| off | on | folder only | one line: the folder |
| off | off | *no call at all* | — |

With filing off the prompt and the parsing are byte-for-byte what they are
today, so the change cannot regress the existing feature.

The two-line prompt, when both are wanted:

```
You name and file chat conversations for a filing system.
Reply with exactly two lines and nothing else:
Title: 3 to 7 words naming the specific topic, in sentence case, no quotes, no trailing punctuation.
Folder: the one folder this conversation belongs in, naming its subject.
Reuse one of the folders that already exist when it fits; invent a new one (1 to 3 words, sentence case) only when none does.
Folders that already exist: Coding, Health, Obsidian setup
```

### Why the existing folders are in the prompt

This is the whole difference between filing and folder sprawl. A model asked
cold produces `Coding` today, `Programming` next week and `Dev` the week after,
and the folder ends up worse than flat. Shown what exists, it reuses. The list
is the top-level subfolders of the conversations folder — `TFolder.children`,
one `getAbstractFileByPath`, no scan — capped at 40 names so a vault that
somehow has hundreds cannot bloat the prompt. On a fresh vault there are none,
and the line is left out rather than sent empty: the model is being asked to
start the vocabulary, not to match a list of nothing.

Folders the importer made (`Claude Code`, `ChatGPT`) appear in that list and are
legitimate targets: a conversation *about* Claude Code belongs there. The prompt
says to name the subject, which is the only steer worth giving.

### Parsing and the fallbacks

`cleanTitle` already survives chatty models ("Sure! Here's a title:"); field
extraction is a labelled-line lookup in front of it. Everything degrades toward
today's behaviour:

- No `Folder:` line → no folder; the transcript goes to the root, exactly as now.
- No `Title:` line → `cleanTitle` over the lines that were not the folder, then
  the existing fall-back to the first message.
- Call fails → both empty, both fall back. Unchanged from today.

### The folder name is untrusted

It is model output, and the answer it was derived from can contain anything the
agent read out of the vault. It is never joined into a path raw:

```ts
/** A model-suggested folder name, made safe to sit under the conversations folder. */
export function folderSlug(label: string): string {
	return conversationSlug(label).replace(/\./g, '').replace(/\s+/g, ' ').trim();
}
```

`conversationSlug` already strips `\ / : * ? " < > | # ^ [ ]` and caps at 40
characters; removing dots on top of that leaves nothing that can climb out of
the folder or nest inside it — no separator survives, so one level is
structural rather than a rule to enforce. An empty result means no folder.

### Where the decision is made

`newConversationPath` in `conversation.ts` takes the folder and puts it between
the conversations folder and the filename; the duplicate-name counter is
unchanged. `saveConversation` already calls `ensureFolder` on the path's parent,
so the folder is created by the write that needs it and never before — a
conversation that fails to save leaves no empty folder behind.

The panel's own `newConversationPath` wrapper makes the call when either setting
is on and the turn was not interrupted (a Stop should not spend a call, as
today), and reports `Naming the conversation…` or `Filing the conversation…`
depending on what it asked for.

### What already handles subfolders

Nothing else has to change, and this is worth stating because it is why filing
is a small change: the history picker matches `path.startsWith(folder + '/')`;
the RAG indexer classifies by `inFolder`, which is prefix-based; permissions use
`underAny`, likewise; `getState`/`setState` carry a full path. Subfolders under
the conversations folder are already first-class — the importer has been writing
them since it shipped.

### The setting

```ts
/** Let the model file each conversation into a folder (shares the naming call). */
fileConversations: boolean;   // default: false
```

Off by default. Naming a file is one thing; creating folders in someone's vault
is another, and an existing install should not sprout a folder tree because it
updated.

Both this and **Let the model name conversations** move out from under
`if (s.autoSaveConversations)` in the settings tab. They now apply to any save,
and hiding them behind auto-save would hide them from exactly the person who
turned auto-save off and saves by hand.

### Alternatives

- **Tie filing to conversation naming.** One toggle, no new setting — but
  turning naming off to save a call would silently stop filing, and turning it
  on would start creating folders unannounced. (Asked and answered: its own
  toggle.)
- **Two calls.** Simpler prompts, and more reliable on a 3B model — at twice the
  cost on a paid endpoint. The one-call form falls back to today's behaviour
  when the format is ignored, so the failure is cheap; if small models turn out
  to mangle it in practice, splitting the call is a contained change.
- **Decide the folder at the end of the conversation** rather than the start.
  There is no reliable "end" to hook — a panel can sit open for days — and the
  first exchange is what the title already comes from.
- **A configured taxonomy.** A knob nobody asked for, and the folders that exist
  already say the same thing.

## 4. What this touches

| File | Change |
| --- | --- |
| `styles.css` | `.va-setting-wide` |
| `src/settings.ts` | `setClass` on 19 rows; `fileConversations` + its toggle; naming and filing toggles unnested from auto-save |
| `src/ui/chat-view.ts` | save button; `persistConversation`; `saving` guard; save condition; pop-out warning; the naming/filing call |
| `src/conversation.ts` | `folderSlug`; folder argument on `newConversationPath`; `conversationFolders` |
| `src/title.ts` → `src/filing.ts` | one call answering title and folder |
| `README.md` | features, the settings table, and the privacy note |

**What could break.** The append-vs-rewrite logic now has two callers; a mistake
there duplicates turns in a transcript, which is the one thing worth testing
hard (save, chat, save, reopen, chat, save). Filing changes where new
transcripts land, so the picker, the semantic index and permissions all see
nested paths — all three are prefix-based and already do, which the acceptance
run confirms rather than assumes.

**Privacy.** The naming call already sends the opening exchange to the
configured endpoint. Filing adds the *names of your conversation subfolders* to
that same call — vault metadata that did not leave before. It is opt-in and off
by default, and `README.md`'s privacy note must say so; `AGENTS.md` requires
exactly that of any feature that transmits anything from the vault.

## 5. Order and verification

1. **QOL-2** — CSS and the marks. Verified by eye in the settings tab, desktop
   and a narrow window.
2. **QOL-1** — `persistConversation`, the button, the guard, the pop-out copy.
   Verified with auto-save off: save, continue, save, reopen, continue, save,
   pop out; and with auto-save on, that nothing about the existing flow changed.
3. **QOL-3** — `filing.ts`, the folder in the path, the setting, the copy.
   Verified against a local llama.cpp server across the four setting
   combinations, plus a forced bad reply to prove the fallbacks.

`npm run lint` and `npm run build` after each.

On completion the durable parts fold into `README.md` and this directory is
deleted, per principle 1.

## 6. Assumptions

- **`Setting.setClass` is in the shipped typings** and puts the class on the row
  element. If it is not, `setting.settingEl.addClass(…)` does the same thing at
  one more line per call site.
- **Obsidian's mobile settings already stack**, so the rule is a no-op there
  rather than a fight with it. Checked when the CSS lands; if it does conflict,
  the rule is scoped with `body:not(.is-mobile)`.
- **A small model can produce two labelled lines** often enough to be worth one
  call instead of two. If it cannot, §3 names the contained fix.
- **The first exchange predicts the topic** well enough to file on. It is the
  same bet conversation naming already makes and has been fine.
- **Nobody is relying on "auto-save off means the plugin never writes"** in a
  way that a save they pressed themselves would violate.
