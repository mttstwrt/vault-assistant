# Plan: RAG + Karpathy's wiki pattern in Vault Assistant

**Status:** Draft for review · **Date:** 2026-07-07

## 1. Goal

Give the agent two complementary retrieval mechanisms and let it use both:

1. **Karpathy's wiki pattern** — a curated, interlinked, human-readable knowledge base that the agent *navigates by following links* from a stable entry point. Deterministic, auditable, structure-encoding.
2. **RAG** — embedding-based semantic search over the raw vault (and optionally the wiki). Fuzzy, recall-oriented, finds things you didn't know to link.

They overlap in purpose (surface the right knowledge at the right time) but differ in mechanism, and each covers the other's blind spot. See §4 for why both earns its keep.

## 2. Where we are today

| Concern | Current state |
| --- | --- |
| Wiki storage | `AI/Wiki/*.md`, always writable (`permissions.ts` → `specialFolders`). |
| Wiki tools | `update_wiki`, `list_wiki`, `links` (`tools/vault-tools.ts`, `tools/graph.ts`). |
| Wiki entry point | **None.** `list_wiki` dumps *every* page + its link graph — O(all pages) in context, machine-shaped, not a curated map. |
| Wiki at session start | **Not injected.** Only *operating memory* is auto-loaded (`memory.ts` → `prompts.ts`). Wiki is fully lazy. |
| Retrieval | Literal substring `search` + `read_file` only. No semantic search. |
| Model client | OpenAI-compatible `/chat/completions` (`api/client.ts`). Embeddings can reuse the same endpoint via `/embeddings`. |
| Constraints to honor | Folder permissions + `readBlockPaths`; mobile-friendly; "keep it small, avoid heavy deps"; privacy/disclosure (`AGENTS.md`); two-layer memory principle: *cheap entry, lazy explore*. |

**Takeaway:** the wiki is ~60% built — the missing 40% is exactly what makes it "Karpathy's pattern" (a curated entry point + link-following traversal + a maintenance loop). RAG is net-new but small.

## 3. Non-goals

- No external vector DB, no native modules, no embeddings library. Brute-force cosine in JS over a personal-scale vault (hundreds–low thousands of notes) is fast enough and keeps the bundle mobile-safe.
- No change to the operating-memory layer, MCP, or the permissions model.
- Not replacing literal `search` — semantic search is added alongside it.

## 4. Why both (not just one)

- **Wiki alone** can't recall a detail nobody thought to write a page about, and its usefulness depends on curation discipline. Cold-start is weak.
- **RAG alone** returns disconnected chunks with no structure; it can't answer "how do these ideas relate," dedupe knowledge, or be audited/edited by the user. It also drifts as the vault grows.
- **Together (hybrid):** RAG is the *fuzzy entry point* ("find me something roughly about X"), the wiki is the *structured destination* the agent hops through once it's landed. Embedding the wiki pages into the same index (§6) means semantic search can drop the agent directly onto the relevant curated page.

## 5. Part A — Complete Karpathy's wiki pattern

The pattern's four ingredients, mapped to what we add:

### A1. A stable entry point (Home / Map of Content)
- Introduce a designated **`Home.md`** (configurable: `wikiHomeNote`, default `Home`) inside the wiki folder. It's the hand-/agent-curated table of contents: top-level topics → `[[links]]` to sections and key pages. Not auto-generated from the file list — curated, so it stays small and meaningful.
- New tool **`wiki_home`** (or reuse `read_file`): returns the Home note. Cheap, bounded, always the starting move.
- Keep `list_wiki` for the *full* graph, but reframe it as the "sitemap / audit" tool used during maintenance, not the default retrieval entry.

### A2. Link-following traversal as the retrieval mechanism
- System-prompt guidance (`settings.ts` → `DEFAULT_SYSTEM_PROMPT`): *to recall curated knowledge, start at the wiki Home, then follow `[[links]]` toward the topic, reading pages as you go — don't dump the whole wiki.* This is the behavioral core of the pattern.
- `links` already exposes outgoing/incoming/broken links per note → this is the hop primitive. Optionally add a convenience tool `wiki_page(title)` that returns the page **plus its neighbor titles** in one call, so a hop costs one tool round instead of two.

### A3. Surface a compact index at session start (respecting "cheap entry, lazy explore")
- Mirror `buildMemorySection`: add `buildWikiSection` that injects **only a compact pointer** — the Home note's title + its top-level headings/links (or the first N lines) — *not* the whole wiki. Gated by a new `useWikiIndex` setting (default on).
- This gives the agent a zero-tool-call sense of "what curated knowledge exists and where to enter," without paying to load the wiki. Directly analogous to the two-layer memory design ([[two-layer-memory-design]]): memory = *how the vault works*, wiki index = *the shape of what's been synthesized*.

### A4. A maintenance / curation loop
- Prompt guidance + a maintenance-oriented framing of existing tools: when adding a page, the agent should also **link it into Home**, fix broken links (surfaced by `links`), and split/merge pages that have grown. No new storage — just discipline encoded in the prompt and a `list_wiki` that reports orphans (pages with no backlinks) and broken links so the agent has a worklist.

### Part A — files touched
- `settings.ts`: `wikiHomeNote`, `useWikiIndex`; extend `DEFAULT_SYSTEM_PROMPT` with traversal + curation guidance; settings-tab controls.
- `tools/graph.ts`: add `buildWikiHomePointer()` (compact) and orphan/broken-link reporting in `buildWikiIndex`.
- `prompts.ts` + new `buildWikiSection` (co-locate near `memory.ts`): inject the compact pointer.
- `tools/vault-tools.ts`: optional `wiki_home` / `wiki_page` tool specs + `executeTool` cases.

**Part A is intentionally small and surgical — it's mostly prompt + one curated note + a compact injector, reusing the existing wiki tools.**

## 6. Part B — Add RAG

### B1. Embeddings source
Reuse the OpenAI-compatible model to stay provider-agnostic. Add a small `embed()` in `api/client.ts` that POSTs to `${embedBaseUrl}/embeddings`.
- New settings: `embedModel` (e.g. `nomic-embed-text` for Ollama, `text-embedding-3-small` for OpenAI) and optional `embedBaseUrl`/`embedApiKey` (default: fall back to the chat `baseUrl`/`apiKey`).
- Both Ollama and LM Studio expose `/v1/embeddings`, so local + offline works.

### B2. Chunking (`src/rag/chunk.ts`)
- Markdown-aware: split each note on headings, then hard-wrap chunks to a max char/token budget with small overlap. Carry `{ path, heading, text }` per chunk.
- Skip anything not `isReadable` (respects `readBlockPaths`).
- **Sources are opt-in and independently toggled:** raw vault (default on), wiki (`ragIndexWiki`), conversations (`ragIndexConversations`). See §7 for wiki and §7a for conversations.

### B3. Vector store (`src/rag/store.ts`)
- In-memory `Float32Array` embeddings + brute-force cosine top-k. No dependency.
- **Persist to the plugin data dir** (`this.manifest.dir` via `app.vault.adapter`), *not* into the vault — keeps the (potentially large) index out of the user's notes and out of sync.
- Store per-chunk content hash → skip re-embedding unchanged chunks on reindex (incremental).

### B4. Indexing lifecycle (`src/main.ts`)
- **Phase 1: manual.** A `reindex-vault` command + settings button. Simple, debuggable.
- **Phase 2: incremental.** `registerEvent(vault.on('modify'/'create'/'delete'))`, debounced, re-embeds only changed files. Use `register*` for clean unload (AGENTS.md rule).
- Show progress + last-indexed count in settings.

### B5. Retrieval tool
- New `semantic_search(query, limit)` tool → embeds the query, returns top-k as `path › heading: …snippet… (score)`. Added to `TOOL_SPECS` + `executeTool`, wired through `ToolContext` (new `rag` field, like `mcp`).

### B6. Permissions & privacy
- **Every chunk passes `isReadable`** before embedding — blocked notes never enter the index, never surface. Re-check on read too.
- Embeddings are a **network egress of note contents**, same privacy class as chat. Must be: opt-in (`useRag`, default **off**), disclosed in `README.md` + `AGENTS.md`, and documented as "local embed model = stays offline."

### Part B — files touched / added
- New `src/rag/chunk.ts`, `src/rag/store.ts` (keep each small, single-responsibility per AGENTS conventions).
- `api/client.ts`: `embed()`.
- `settings.ts`: `useRag`, `embedModel`, `embedBaseUrl?`, `embedApiKey?`, `ragTopK`, `ragIndexWiki`, `ragIndexConversations`; settings-tab section + reindex button.
- `main.ts`: instantiate store, register indexing events + `reindex` command.
- `agent.ts` / `tools/vault-tools.ts`: thread `rag` into `ToolContext`; add `semantic_search`.
- `README.md`, `AGENTS.md`: disclosure.

## 7. Part C — Hybrid composition

- **Embed the wiki too** (opt-in `ragIndexWiki`): semantic search can then land the agent directly on the relevant curated wiki page — RAG becomes the fuzzy front door to the structured graph.
- **Prompt guidance on which tool when:**
  - Known/structured topic → start at wiki Home, follow links.
  - "Somewhere I wrote about…" / fuzzy recall → `semantic_search`, then hop into the wiki / read the source note.
  - Exact string/filename → keep `search`.
- Keep the tools **separate and named for what they do**, so both the agent's reasoning and the user's audit trail stay legible (Karpathy: deterministic, inspectable over magic).

## 7a. Conversations as a memory source (opt-in `ragIndexConversations`)

The vector store doubles as an un-curated memory of past chats — recall the wiki won't hold because the agent never distilled it ("somewhere we talked about X"). Worth including, but embed a **filtered view**, not raw transcripts:

- **Embed only** the human-authored turns + the agent's *final* answers. **Drop** tool calls, tool results, and intermediate scratch — that's noise, not memory, and it's where wrong pre-correction statements live.
- **Feedback-loop guard:** conversations are auto-saved, so raw embedding makes the agent's own output a retrieval target that it re-quotes and re-saves, compounding errors. Filtering to final answers + human turns shrinks this surface; keeping conversations behind their own toggle lets it be scoped or disabled if drift appears.
- **Relationship to the wiki:** conversation embeddings are the *raw fallback*, not a replacement for distilling chats into curated wiki pages. Prompt guidance should still push synthesis into the wiki; semantic recall over conversations is the safety net for what wasn't synthesized.
- Future refinement (not now): recency weighting so stale chatter decays. Don't build until needed.

## 8. Open decisions (need your call before build)

**All decided (locked):**
- **Vector store location** → plugin data dir (`manifest.dir`), off-vault. Keeps the index out of notes and off sync.
- **Index freshness** → phased: manual reindex first, incremental-on-save follow-up.
- **What gets embedded** → vault (on) + wiki + conversations, each an independent opt-in toggle. Conversations embed a filtered view (§7a), not raw transcripts.
- **Wiki index injection** → inject a compact Home pointer at session start, gated by `useWikiIndex` (default on). Preserves the cheap-entry / lazy-explore principle.
- **Embed endpoint** → default to the chat `baseUrl`/`apiKey`, with optional `embedBaseUrl`/`embedApiKey` overrides (for chat-remote / embeddings-local setups). A separate `embedModel` either way.

## 9. Phased delivery with verification

Each phase ends green on `npm run build` + `npm run lint`, plus a manual check.

| Phase | Scope | Verify |
| --- | --- | --- |
| **A** | Wiki Home note + compact session injection + traversal/curation prompt + orphan/broken-link reporting | Fresh session shows the Home pointer with zero tool calls; ask a curated question → agent starts at Home and hops via `links` rather than dumping `list_wiki`. |
| **B1** | `embed()` + chunking + store + manual `reindex` + `semantic_search` (vault only, opt-in, permission-checked) | Reindex populates the store (count shown); `semantic_search` on a known concept returns the right note in top-k; a `readBlockPaths` note never appears. |
| **B2** | Incremental indexing on file change (debounced) + progress UI | Edit a note → only that note re-embeds; delete → its chunks drop; unload leaks no listeners. |
| **C** | Embed wiki pages + filtered conversations + hybrid prompt guidance | `semantic_search` surfaces a wiki page and a past-chat snippet; conversation chunks contain no tool-call noise; transcript shows the agent choosing wiki-traversal vs. semantic-search appropriately. |

## 10. Risks & mitigations

- **Index size / memory on mobile** → cap indexed folders, store off-vault, brute-force is fine at personal scale; document a soft ceiling and let users scope with `readBlockPaths` / an include-list if needed.
- **Embedding cost/latency on remote endpoints** → incremental + content-hash skip; opt-in; recommend local embed model.
- **Privacy** → strict `isReadable` gate on every chunk; opt-in + disclosure.
- **Wiki bloat / drift** → curation loop (link into Home, fix orphans/broken links) is the counter-pressure; keep the injected pointer compact.
- **Overlap confusion** → distinct tool names + explicit prompt guidance on which to use when.

