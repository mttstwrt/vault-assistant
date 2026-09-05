# Tasks: knowing itself, and reaching Obsidian properly

Requirements: [requirements.md](requirements.md) · Design: [design.md](design.md)

Order follows design §10. `minAppVersion` stays at 1.7.2: every API this change
reaches for clears it (`renameFile` 0.11, `process` 1.1, `createFolder` 1.4,
`resolveSubpath` 0.9.16, `getFirstLinkpathDest` 0.12.5). The one that would have
forced a bump, `Vault.copy` at 1.8.7, belongs to a non-goal.

## 0. Baseline

- [ ] **Tool-selection baseline (needs Obsidian + an endpoint).** The prompt set
      in §7 below, run against the current 13 tools on Gemma 3 27B and Qwen3 32B,
      recording first-call accuracy and rounds-to-answer. Re-run at 20 tools once
      the change lands.

## 1. Search, listing, path resolution

- [x] `src/tools/search.ts`: the scan, with regex/whole-word/invert/context/
      multiline/files-only/scope, `path:line:` output, 200-char pattern cap and a
      compile that reports rather than throws.
- [x] `src/tools/vault-tools.ts`: `search` spec rewritten; body delegates.
- [x] `src/prepass.ts`: `literalSearch` deleted, calls the shared scan.
- [x] `list_files` gains `depth` (default 1, max 4, 500-entry cap).
- [x] `src/tools/paths.ts`: `getFirstLinkpathDest` tried before the hand-rolled
      basename scan, so aliases and bare filenames resolve Obsidian's way.

## 2. Sections, tags, atomic writes

- [x] `src/tools/sections.ts`: `sectionRange` over `resolveSubpath`; `outline`,
      `read_section`, `write_section`. Heading accepted as `heading` or as a
      `path#heading` suffix. Not-found names the headings that exist.
- [x] `src/tools/tags.ts`: `tags`, over `getAllTags`, hierarchy-aware.
- [x] `Vault.process` for `append_file`, `remember` (append) and `update_wiki`
      (append) — the read-then-write race, fixed.
- [x] Specs + dispatch for the four new tools.

## 3. Structure: folders and moves

- [x] `src/tools/files.ts`: the one `ensureFolder` (copies in `conversation.ts`
      and `vault-tools.ts` deleted), `createFolder`, `moveFile`.
- [x] `src/types.ts`: `ApprovalRequest.kind` gains `'move' | 'create-folder'`,
      plus `toPath`.
- [x] `src/ui/chat-view.ts`: card branches for both; `always-file` suppressed on
      a folder create.
- [x] `move_file`: destination rule (existing folder → move into it), both-ends
      permission, folder-with-unreadable-children refused, backlink count before
      and after with a 3s `metadataCache.on('resolved')` wait.
- [x] `src/tools/graph.ts`: export `buildBacklinks`.
- [x] `src/ui/chat-view.ts`: follow `vault.on('rename')` so a moved transcript
      does not resurrect its old path.

## 4. Aliases

- [x] `src/tools/aliases.ts`: move/rename/mkdir names out of `UNSUPPORTED` into
      redirects; `UNSUPPORTED` narrowed to delete and copy and its message
      corrected; `head`/`tail`/`tree`/`find` read aliases; `to`/`heading`
      argument aliases.

## 5. Capabilities

- [x] `src/tools/capabilities.ts`: the five-part report from `offered`, the
      permission helpers, and `alwaysUpdateLinks` read from
      `<configDir>/app.json` with an honest fallback.
- [x] `src/prompts.ts`: the one line telling the model to call it.

## 6. Typed links

- [x] `src/wikilinks.ts`: parse (skipping code fences), resolve, slice, budget,
      dedupe; near-miss naming for a link that matches nothing.
- [x] `src/ui/chat-view.ts`: expand in `send()` into the user turn; the
      `↘ inlined …` line under the bubble.
- [x] `src/conversation.ts` + `src/rag/chunk.ts`: shared fence tracking, so an
      inlined transcript cannot split a turn and inlined text is not embedded.
- [x] `src/settings.ts`: `expandTypedLinks` (default true) and its row.

## 7. Docs and checks

- [x] `README.md`: tool list, feature bullets, the inliner's settings row, the
      privacy paragraph.
- [x] `AGENTS.md`: the egress paragraph gains the inliner.
- [x] `docs/future-work.md`: link autocomplete in the composer (what it would
      take), and model tool-calling capability vs. the token cost of the tool
      block.
- [x] `npm run lint`, `npm run build`.
- [x] Probe the untrusted/fragile paths outside Obsidian against stubs: the
      wikilink parser, the section slicer, the regex search, and the move
      destination rule.
- [ ] **Acceptance run (requirements §4) — needs Obsidian and an endpoint.**

### Tool-selection prompt set (task 0)

Each prompt has one correct first tool call. Score first-call accuracy and
rounds-to-answer.

| # | Prompt | Correct first call |
| --- | --- | --- |
| 1 | What's in my Notes folder? | `list_files` |
| 2 | Summarise the note I'm looking at | `open_files` |
| 3 | Find every note mentioning "chunk overlap" | `search` |
| 4 | What headings does Notes/Ideas.md have? | `outline` |
| 5 | What does Notes/Ideas.md say under Chunking? | `read_section` |
| 6 | What have I tagged #project? | `tags` |
| 7 | What links to Notes/Ideas.md? | `links` |
| 8 | Move Notes/Ideas.md into Archive | `move_file` |
| 9 | Make a folder called Archive/2026 | `create_folder` |
| 10 | Can you delete a note? | `capabilities` |
| 11 | Add a line to the end of Notes/Ideas.md | `append_file` |
| 12 | Rewrite the Overlap section of Notes/Ideas.md | `read_section` |
