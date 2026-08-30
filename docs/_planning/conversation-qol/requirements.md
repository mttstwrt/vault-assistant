# Requirements: conversation and settings quality-of-life

**Status:** Draft for review · **Date:** 2026-08-30

Three changes, taken together because two of them meet at the same line of code
— the one that decides where a transcript is written: a **save button** for the
panel, **full-width inputs** in the settings tab, and **automatic filing** of
new conversations into folders the model picks.

## 1. Why now

**Auto-save is all or nothing.** With **Auto-save conversations** off, a chat is
never written anywhere. There is no way to decide, three turns in, that this one
was worth keeping — the only way to get a transcript is to have turned the
setting on before you started. The panel already feels this: the pop-out button
warns that the conversation cannot follow it to a new window, because an
auto-saved transcript is the only thing that travels.

**The settings tab is mostly long values in a short box.** Endpoint URLs, vault
paths, and model names like `text-embedding-nomic-embed-text-v1.5` all live in
the control column of a `Setting` row, which is sized for a number or a toggle.
Every one of them is edited a few characters at a time, scrolled sideways.

**The conversations folder only sorts one way.** Every transcript lands flat in
`AI/Conversations`, named `2026-08-12 1432 Reworking the RAG chunker.md`. That
sorts by date, which is the axis you least often search by; a year of chatting
is one long list. Everything needed to sort them already exists — the importer
writes into subfolders (`Claude Code/LightView`), the history picker matches on
path prefix so it already lists them, and folder permissions already cover
anything under the conversations folder. The only missing piece is deciding a
folder for a conversation that starts in the panel.

## 2. Goals

**QOL-1 — Save button.** A save button in the panel header that writes the open
conversation to the conversations folder now, whatever **Auto-save
conversations** says. It produces exactly the file auto-save would have produced
— same name, same folder, same format — and saving twice does not make two
files. Once a conversation has a file, the panel keeps that file current as the
conversation continues (§3 of the design says why this is a save button and not
a save-a-copy button).

**QOL-2 — Settings inputs get the row.** Settings that hold a long value put
their name and description on one line and a full-width input beneath it.
Numbers (temperature, rounds, top-K) and toggles keep the compact row they have
now, because a full-width box for `0.7` reads as a mistake.

**QOL-3 — Filing.** A new setting, **Let the model file conversations into
folders**, off by default. When on, the same cheap call that titles a
conversation also names the one folder under the conversations folder it belongs
in, and the transcript is written there. Folders that already exist are put in
front of the model to reuse, so the vocabulary settles instead of drifting into
`Coding`, `Programming` and `Dev`. It is its own toggle, not part of
conversation naming: naming picks a filename, filing creates folders in your
vault, and those are different enough to want one without the other.

## 3. Non-goals

- **No backfill.** Transcripts already in the folder stay where they are. A
  batch re-file command needs link-safe moves, a preview you can refuse, and a
  cost estimate for paid endpoints; it is a bigger change than these three, and
  it is better attempted once the folder vocabulary has proved itself on new
  conversations.
- **No re-filing.** The folder is decided once, at the first save, from the
  opening exchange. A conversation that wanders into another topic stays where
  it was filed; reopening one never moves it.
- **One level of folder.** No nesting, no `Coding/Obsidian`. A model given
  freedom to nest will build a tree nobody asked for.
- **No taxonomy configuration** — no allow-list of folder names, no rules, no
  regex. The folders you already have are the taxonomy, and the model is shown
  them.
- **No unsaved-state indicator, no save-on-close, no save interval.** The button
  saves; nothing else in the panel changes behaviour.
- No change to the transcript format, the import path, the permissions model, or
  the agent loop.
- No restyling of the settings tab beyond the width of the input row.

## 4. Acceptance

With **Auto-save conversations** off:

1. Chat, then press save: a transcript appears in the conversations folder,
   named the way an auto-saved one would be. The history button reopens it.
2. Keep chatting after saving: the new turns reach the same file, and reopening
   it shows the whole conversation once — no duplicated turns, no second file.
3. Pressing save while the model is answering refuses with the same notice the
   other header buttons give.
4. Pop out to a new window after saving: the conversation follows. The
   "cannot follow the panel" warning appears only when nothing has been saved.

Settings tab:

5. Base URL, API key, Model, the folder and file paths, and the embedding fields
   each show a full-width input under their description. Temperature, Max tool
   steps, Default rounds, Every (hours) and Results per search keep a small box
   on the right, and every toggle and dropdown row is unchanged.

Filing, against a local llama.cpp server:

6. Filing on, naming on: the first save of a chat about note-taking lands at
   `AI/Conversations/<folder>/2026-08-30 1432 <title>.md`, and exactly **one**
   model call was made to decide both.
7. Filing on, naming off: a folder is chosen; the file is still named after the
   first message.
8. Filing off: the path is byte-for-byte what it is today.
9. A second conversation on the same topic is filed into the folder the first
   one created, not a synonym of it.
10. A model that replies with junk, ignores the format, or answers
    `../../../etc` files the conversation at the root of the conversations
    folder and never outside it.

`npm run lint` and `npm run build` pass.

---

Design: [design.md](design.md) · Repository README: [../../../README.md](../../../README.md)
