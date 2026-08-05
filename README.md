# Vault assistant

A minimalist AI chat panel for [Obsidian](https://obsidian.md) that gives a language model access to your vault the way a coding agent (Claude Code, opencode) sees a repository — it can list, search, read, and (only where you allow it) write notes.

It works with any **OpenAI-compatible** endpoint: local runners like **Ollama** and **LM Studio**, or hosted APIs like OpenAI and OpenRouter.

## A note on privacy

If you point the plugin at a remote endpoint, the contents of notes the agent reads are sent to that service. While **See what you have open** is enabled (the default), the *paths* of your open tabs are also sent with each message so the agent knows what you are looking at — paths inside blocked folders are excluded, and the setting turns the whole thing off. Use a local model (Ollama/LM Studio) to keep everything offline. If you enable **semantic search** (off by default), the notes being indexed are additionally sent to the embedding endpoint — use a local embedding model (e.g. `nomic-embed-text` on Ollama) to keep that offline too. Folders you block from reading are never indexed and never sent anywhere. The plugin makes no other network calls and has no telemetry. Note that a **workflow run** keeps calling your model endpoint unattended until it pauses or you stop it — on a paid API, set a rounds budget and keep an eye on cost.

The optional **conversation import** processes everything locally and only when you explicitly run it: the Claude Code source (desktop only) reads session logs from your local `~/.claude` directory — files outside your vault — and the claude.ai/ChatGPT sources read only the export file you pick. Nothing the importer reads leaves your machine; it just writes cleaned transcripts into your conversations folder.

## Features

- **Chat side panel** — open from the ribbon (bot icon) or the command **Vault assistant: Open chat**.
- **Stop anytime** — while the agent is working, **Send** becomes **Stop** (also the command **Stop the current response**). It drops the model call in flight and ends the turn at the next step instead of waiting the answer out — useful when a local model is grinding, or the agent has clearly gone the wrong way. Whatever it already said and did is kept and saved, and you can just type the next message. The same button stops a workflow run.
- **Vault-aware agent** — the model is given tools to explore your notes and ground its answers in them:
  - `list_files`, `read_file`, `search`
  - `semantic_search` — embedding-based recall (when semantic search is enabled)
  - `links` — outgoing links and backlinks for any note
  - `open_files` — what you have open in Obsidian and which note is focused
  - `write_file`, `append_file` (writable folders only)
  - `wiki_home`, `wiki_page` — enter the wiki at its curated Home page and hop through it by `[[links]]`
  - `list_wiki` — the wiki sitemap (all pages, their links, orphans and broken links)
  - `update_wiki` — create or expand an interlinked wiki note
  - `remember` — save a durable fact to the agent's operating memory
- **Knows what you're looking at** — the agent sees which notes are open in Obsidian and which one is focused, refreshed before every message you send. So "what am I looking at?", "summarise this", or "add a task to this note" just work, with no need to name the file (and it can re-check mid-answer with `open_files`). Open tabs in blocked folders are never listed; if the note you're focused on is blocked, the agent is told only that it can't see it, so it says so instead of answering about the wrong note. Turn the whole thing off with **See what you have open**.
- **Folder-scoped permissions** — decide exactly what the agent may read and write. By default it can read everything but write **nothing** except the conversations, wiki, and memory files, so your own notes stay untouched.
- **Auto-saved conversations** — every chat is written to your conversations folder as a markdown note. Reopen any saved conversation from the panel's history button and keep talking; new turns are appended to the same note.
- **Conversation import** — bring past AI conversations into the vault as clean transcripts (your messages plus the assistant's thinking and answers; tool calls and noise are dropped), so they join your second brain: searchable, indexable, and continuable like any other conversation. Sources: local **Claude Code** sessions (desktop only) — including a "Prompt history" rescue of your prompts from sessions Claude Code has already cleaned up — plus **claude.ai** and **ChatGPT** data exports (unzip and pick `conversations.json`; no login needed, everything is processed locally).
- **Growing wiki** — the agent saves synthesised knowledge to a wiki folder using `[[wikilinks]]`, so a connected second brain builds up as you talk. A curated **Home** page is the table of contents: the agent starts there, follows links toward a topic, and links every new page back in. A compact pointer to Home is injected at session start so the agent knows what curated knowledge exists without loading any of it.
- **Agent workflows** — give the agent a goal and a *workflow* (telescope button, or the command **Run workflow**) and let it work autonomously, round by round. Self-describing workflows (wiki gardener, life coach, weekly review) pre-fill their goal so you can just hit Start; edit it or write your own for open-ended runs like deep research. Built-in presets: **Deep research** (multi-round investigation), **Wiki gardener** (link orphans, fix broken links, expand thin pages), and **Weekly review** (gather the week, write a review note). Workflows are plain notes: run **Create workflow preset note** to copy a preset into your workflows folder (default `AI/Workflows`) and edit its steps — each step sets its own prompt, temperature, model, tool allowlist, and approval policy in frontmatter, and a vault copy shadows the built-in with the same name. To *see* a workflow, the picker previews the selected workflow's steps inline (temperature, tools, approval badges), and **View workflow as canvas** (command, or the node icon next to the picker) exports it as an Obsidian canvas — one node per step, edges for flow, a loop-back edge for looping workflows. The canvas is a regenerable view; the note stays the source of truth. Each round starts fresh from a *run note* that accumulates the goal and every report, so runs stay inside the model's context window, survive restarts, and can be resumed with a new budget anytime. You choose the rounds per run (0 = until stopped) and an optional delay between rounds; Stop halts at the next step. On autonomous steps, out-of-scope writes are auto-denied so an unattended run never stalls — durable insights go to the wiki as usual, and the agent ends a finite goal by calling `finish_run`.
- **Semantic search (opt-in)** — index your vault with any OpenAI-compatible embedding model and give the agent fuzzy, meaning-based recall alongside literal search. Optionally index the wiki (so semantic search lands on curated pages) and past conversations (filtered to your messages and the agent's final answers). The index lives in the plugin folder — never in your notes — updates incrementally as you edit, and strictly respects blocked folders.
- **Context pre-pass (opt-in)** — before each of your messages, one cheap model call expands it into a few search queries, runs them against the vault (semantic when enabled, literal otherwise), and injects the top hits into the system prompt. Built for small local models, which ground better and burn fewer tool rounds when the relevant notes are already in front of them.
- **Life Tracker integration** — if the [Life Tracker](https://github.com/) plugin is installed, enable the pre-seeded "Life Tracker" entry under MCP servers and the agent gains tools to read your habits/maintenance/projects data, log events, plan items into your daily note, and pull computed summaries (streaks, overdue, goals). It runs in-process (no server, works on mobile) and write tools go through the same approval flow as vault writes.
- **Life coach on a schedule** — the built-in *Life coach* workflow reads your goals note (`AI/Goals.md` by default), pulls your Life Tracker summaries, calls out imbalances candidly, and plans tomorrow's blocks into your daily note. Enable **Scheduled runs** in settings to have it (or any workflow) run headlessly every N hours while Obsidian is open, with a catch-up run after startup; each run appends its coaching report to a run note and pops a notice when done.
- **Operating memory** — a small, curated note (`AI/Memory.md` by default) injected into the agent at the start of every conversation. When you correct it ("habits live here now, not there") it records the fact with `remember`, so it stops relearning how your vault is organised. The wiki holds *what's in* your vault; memory holds *how it works*.

## Settings

**Model endpoint**

| Setting | Description |
| --- | --- |
| Base URL | OpenAI-compatible base, e.g. `http://localhost:11434/v1` (Ollama), `http://localhost:1234/v1` (LM Studio), `https://api.openai.com/v1`. |
| API key | Optional. Leave empty for local models. |
| Model | Model name your endpoint expects, e.g. `llama3.1`, `gpt-4o-mini`. |
| Temperature | Sampling temperature. |
| Max tool steps | How many tool-call rounds the agent may take per message. |
| Send extra request parameters | Optional. Merge a JSON object into every chat request to enable server-side samplers your endpoint supports — e.g. llama.cpp's dynamic temperature (`dynatemp_range`, `dynatemp_exponent`) or mirostat. llama.cpp's OpenAI-compatible server accepts these; Ollama's OpenAI route ignores them (use a Modelfile there instead). |

**Folder permissions**

| Setting | Description |
| --- | --- |
| Read scope | Entire vault, or only an allowlist of folders (e.g. your daily notes). |
| Writable folders | Folders the agent may create/edit files in. Empty = it never touches your own notes. |
| Conversations folder | Where transcripts are saved (always writable). Default `AI/Conversations`. |
| Wiki folder | Where the generated wiki lives (always writable). Default `AI/Wiki`. |
| Auto-save conversations | Save each chat as you go. |
| See what you have open | On by default. Tells the agent which notes are open and which is focused (and exposes `open_files`), so "this note" resolves without naming a file. Blocked folders are never listed. |

**Operating memory**

| Setting | Description |
| --- | --- |
| Use operating memory | Inject the memory file each session and expose the `remember` tool. |
| Memory file | Path to the curated memory note (always readable/writable). Default `AI/Memory.md`. Loaded in full each session, so keep it concise. |

**Wiki**

| Setting | Description |
| --- | --- |
| Home page title | The curated entry page inside the wiki folder. Default `Home`. |
| Show wiki index at session start | Inject a compact pointer to the Home page into each new conversation. |

**Workflows**

| Setting | Description |
| --- | --- |
| Runs folder | Where workflow-run notes (the goal plus each round's report) are saved. Always writable. Default `AI/Research`. |
| Workflows folder | Where workflow definition notes live; notes with `steps` in frontmatter appear in the picker alongside the built-in presets. Always writable. Default `AI/Workflows`. |
| Default rounds per run | Rounds budget suggested when starting a run. 0 = run until stopped. |
| Default delay between rounds | Seconds to pause between rounds, suggested when starting a run. |
| Goals note | The note workflows reference via `{{goalsFile}}` (the life coach reads it). Always writable. Default `AI/Goals.md`. |

**Scheduled runs**

| Setting | Description |
| --- | --- |
| Run a workflow on a schedule | Headless runs every N hours while Obsidian is open, one round per run, catch-up after startup. |
| Workflow to run | Any built-in preset or workflow note. Default: Life coach. |
| Every (hours) | 24 = once a day. |
| Goal for scheduled runs | Seeds fresh run notes; `{{goalsFile}}` expands to your goals note path. |

**Semantic search**

| Setting | Description |
| --- | --- |
| Enable semantic search | Off by default. Indexing sends note contents to the embedding endpoint — use a local model to stay offline. |
| Embedding model | e.g. `nomic-embed-text` (Ollama), `text-embedding-3-small` (OpenAI). |
| Embedding base URL / API key | Optional overrides; default to the chat endpoint and key. |
| Results per search | How many chunks `semantic_search` returns. |
| Index wiki pages | Also embed the wiki so search lands on curated pages. |
| Index conversations | Also embed saved chats, filtered to your messages + final answers. |
| Reindex now | Rebuild the index (also available as the command **Reindex vault for semantic search**). Unchanged chunks are skipped; edits reindex automatically afterwards. |

The conversations, wiki, and research folders and the memory file are always writable; everything else is read-only unless you add it to **Writable folders**.

## Development

```bash
npm install
npm run dev      # watch build
npm run build    # type-check + production bundle
npm run lint
```

Both `npm run dev` and `npm run build` write the bundle to `dist/`, alongside
copies of `manifest.json` and `styles.css`, so `dist/` is a complete, loadable
plugin folder.

To test in a vault, copy the contents of `dist/` (`main.js`, `manifest.json`,
`styles.css`) into `<Vault>/.obsidian/plugins/vault-assistant/` and enable the
plugin under **Settings → Community plugins**. (For local development the plugin
folder name should match the `id` in `manifest.json`.)
