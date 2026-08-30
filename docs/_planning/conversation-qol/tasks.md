# Tasks: conversation and settings quality-of-life

Requirements: [requirements.md](requirements.md) · Design: [design.md](design.md)

Order follows design §5: the width change touches no behaviour, the save button
refactors the persistence path, and filing extends what the save button touched.

## 1. Settings inputs (QOL-2)

- [ ] `styles.css`: add `.va-setting-wide` — stack the row, control full width,
      input/textarea `flex: 1 1 auto; width: 100%; min-width: 0`.
- [ ] `src/settings.ts`: `.setClass('va-setting-wide')` on the 13 text rows and
      6 textarea rows listed in design §1. Leave the 8 numeric rows and every
      toggle/dropdown/button row alone.
- [ ] Check the Model row (text + refresh button) and the Embedding model row
      (text + refresh) still put the button beside the input, not below it.

## 2. Save button (QOL-1)

- [ ] `src/ui/chat-view.ts`: extract `persistConversation(interrupted = false)`
      from the tail of `send()`; it resolves the path (naming call) when there
      isn't one, then appends or rewrites, and returns the path or null.
- [ ] `send()` calls it under `autoSaveConversations || conversationPath`,
      before `setBusy(false)`.
- [ ] `firstUserMessage()` helper — what the button feeds the naming call.
- [ ] `saving` flag; `saveNow()`; both guards in `send()` and `saveNow()`.
- [ ] Header: `save` button between **New chat** and **Open previous
      conversation**, `aria-label` "Save conversation".
- [ ] Pop-out warning reads `!this.conversationPath`, and its copy says to save
      first.

## 3. Filing (QOL-3)

- [ ] `src/conversation.ts`: `folderSlug`, `conversationFolders`, and the
      `folder` argument on `newConversationPath`.
- [ ] `git mv src/title.ts src/filing.ts`; module comment covers naming *and*
      filing; `suggestFiling(settings, userMessage, answer, want)` returning
      `{ title, folder }`; the three prompt shapes and the labelled-line parse
      with fall-backs to today's behaviour.
- [ ] `src/settings.ts`: `fileConversations` (default `false`) + its toggle;
      unnest it and the naming toggle from `if (s.autoSaveConversations)`.
- [ ] `src/ui/chat-view.ts`: the panel's `newConversationPath` asks for whichever
      halves are enabled, and reports naming vs filing in the status line.

## 4. Docs and checks

- [ ] `README.md`: the auto-saved-conversations feature bullet (save button,
      filing), a settings-table row for the new toggle, and the privacy note —
      filing sends your conversation folder *names* with the naming call.
- [ ] `npm run lint`, `npm run build`.
- [ ] Acceptance run (requirements §4), then fold the durable parts into the
      README and delete `docs/_planning/conversation-qol/`.
