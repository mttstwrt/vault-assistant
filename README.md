# Vault assistant

A minimalist AI chat panel for [Obsidian](https://obsidian.md) that gives a language model access to your vault the way a coding agent (Claude Code, opencode) sees a repository — it can list, search, read, and (only where you allow it) write notes.

It works with any **OpenAI-compatible** endpoint: local runners like **Ollama** and **LM Studio**, or hosted APIs like OpenAI and OpenRouter.

## A note on privacy

If you point the plugin at a remote endpoint, the contents of notes the agent reads are sent to that service. Use a local model (Ollama/LM Studio) to keep everything offline. If you enable **semantic search** (off by default), the notes being indexed are additionally sent to the embedding endpoint — use a local embedding model (e.g. `nomic-embed-text` on Ollama) to keep that offline too. Folders you block from reading are never indexed and never sent anywhere. The plugin makes no other network calls and has no telemetry.

## Features

- **Chat side panel** — open from the ribbon (bot icon) or the command **Vault assistant: Open chat**.
- **Vault-aware agent** — the model is given tools to explore your notes and ground its answers in them:
  - `list_files`, `read_file`, `search`
  - `semantic_search` — embedding-based recall (when semantic search is enabled)
  - `links` — outgoing links and backlinks for any note
  - `write_file`, `append_file` (writable folders only)
  - `wiki_home`, `wiki_page` — enter the wiki at its curated Home page and hop through it by `[[links]]`
  - `list_wiki` — the wiki sitemap (all pages, their links, orphans and broken links)
  - `update_wiki` — create or expand an interlinked wiki note
  - `remember` — save a durable fact to the agent's operating memory
- **Folder-scoped permissions** — decide exactly what the agent may read and write. By default it can read everything but write **nothing** except the conversations, wiki, and memory files, so your own notes stay untouched.
- **Auto-saved conversations** — every chat is written to your conversations folder as a markdown note.
- **Growing wiki** — the agent saves synthesised knowledge to a wiki folder using `[[wikilinks]]`, so a connected second brain builds up as you talk. A curated **Home** page is the table of contents: the agent starts there, follows links toward a topic, and links every new page back in. A compact pointer to Home is injected at session start so the agent knows what curated knowledge exists without loading any of it.
- **Semantic search (opt-in)** — index your vault with any OpenAI-compatible embedding model and give the agent fuzzy, meaning-based recall alongside literal search. Optionally index the wiki (so semantic search lands on curated pages) and past conversations (filtered to your messages and the agent's final answers). The index lives in the plugin folder — never in your notes — updates incrementally as you edit, and strictly respects blocked folders.
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

**Folder permissions**

| Setting | Description |
| --- | --- |
| Read scope | Entire vault, or only an allowlist of folders (e.g. your daily notes). |
| Writable folders | Folders the agent may create/edit files in. Empty = it never touches your own notes. |
| Conversations folder | Where transcripts are saved (always writable). Default `AI/Conversations`. |
| Wiki folder | Where the generated wiki lives (always writable). Default `AI/Wiki`. |
| Auto-save conversations | Save each chat as you go. |

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

The conversations and wiki folders and the memory file are always writable; everything else is read-only unless you add it to **Writable folders**.

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
