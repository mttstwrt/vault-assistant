# Tasks: conversation and settings quality-of-life

Requirements: [requirements.md](requirements.md) · Design: [design.md](design.md)

Order follows design §5: the width change touches no behaviour, the save button
refactors the persistence path, and filing extends what the save button touched.

## 1. Settings inputs (QOL-2)

- [x] `styles.css`: add `.va-setting-wide` — stack the row, control full width,
      input/textarea `flex: 1 1 auto; width: 100%; min-width: 0`.
- [x] `src/settings.ts`: `.setClass('va-setting-wide')` on the 13 text rows and
      6 textarea rows listed in design §1. Leave the 8 numeric rows and every
      toggle/dropdown/button row alone.
- [x] The Model row (text + refresh button) keeps the button beside the input:
      `flex: 1 1 auto; min-width: 0` rather than `width` alone. Written for it,
      but confirmed only by reading the CSS — it wants an eye in the acceptance
      run, like the rest of the layout.

## 2. Save button (QOL-1)

- [x] `src/ui/chat-view.ts`: extract `persistConversation(interrupted = false)`
      from the tail of `send()`; it resolves the path (naming call) when there
      isn't one, then appends or rewrites, and returns the path or null.
- [x] `send()` calls it under `autoSaveConversations || conversationPath`,
      before `setBusy(false)`.
- [x] `firstUserMessage()` helper — what the button feeds the naming call.
- [x] `saving` flag; `saveNow()`; both guards in `send()` and `saveNow()`.
- [x] Header: `save` button between **New chat** and **Open previous
      conversation**, `aria-label` "Save conversation".
- [x] Pop-out warning reads `!this.conversationPath`, and its copy says to save
      first.

## 3. Filing (QOL-3)

- [x] `src/conversation.ts`: `folderSlug`, `conversationFolders`, and the
      `folder` argument on `newConversationPath`.
- [x] `git mv src/title.ts src/filing.ts`; module comment covers naming *and*
      filing; `suggestFiling(settings, userMessage, answer, want)` returning
      `{ title, folder }`; the three prompt shapes and the labelled-line parse
      with fall-backs to today's behaviour.
- [x] `src/settings.ts`: `fileConversations` (default `false`) + its toggle;
      unnest it and the naming toggle from `if (s.autoSaveConversations)`.
- [x] `src/ui/chat-view.ts`: the panel's `newConversationPath` asks for whichever
      halves are enabled, and reports naming vs filing in the status line.

## 4. Docs and checks

- [x] `npm run lint`, `npm run build`.
- [x] Probed the two untrusted/fragile paths outside Obsidian, by bundling the
      real modules against stubs: `folderSlug` over traversal, separators,
      dotfiles and overlong names (everything lands one level down, or at the
      root); the reply parser over obedient, chatty, reordered, markdown-
      decorated, unlabelled, junk, empty and failed replies. Two defects that
      found: a `- **Folder**: x` line was not recognised, and `Folder:` was
      kept as part of the folder name in folder-only mode. Both fixed.
- [x] `README.md` folded in as the change landed (feature bullet, settings
      table, privacy note, pop-out copy).
- [ ] **Acceptance run (requirements §4) — needs Obsidian and an endpoint, so it
      is the one step that cannot be done from a build environment.** Once it
      passes, delete `docs/_planning/conversation-qol/`; git history is the
      record of what was tried.
