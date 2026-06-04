# AI vault chat

A minimalist AI chat panel for [Obsidian](https://obsidian.md) that gives a language model access to your vault the way a coding agent (Claude Code, opencode) sees a repository — it can list, search, read, and (only where you allow it) write notes.

It works with any **OpenAI-compatible** endpoint: local runners like **Ollama** and **LM Studio**, or hosted APIs like OpenAI and OpenRouter.

## Features

- **Chat side panel** — open from the ribbon (bot icon) or the command **AI vault chat: Open chat**.
- **Vault-aware agent** — the model is given tools to explore your notes and ground its answers in them:
  - `list_files`, `read_file`, `search`
  - `links` — outgoing links and backlinks for any note
  - `write_file`, `append_file` (writable folders only)
  - `list_wiki` — the existing wiki graph (notes + how they interlink)
  - `update_wiki` — create or expand an interlinked wiki note
- **Folder-scoped permissions** — decide exactly what the agent may read and write. By default it can read everything but write **nothing** except the conversations and wiki folders, so your own notes stay untouched.
- **Auto-saved conversations** — every chat is written to your conversations folder as a markdown note.
- **Growing wiki** — the agent saves synthesised knowledge to a wiki folder using `[[wikilinks]]`, so a connected second brain builds up as you talk.

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

The conversations and wiki folders are always writable; everything else is read-only unless you add it to **Writable folders**.

## A note on privacy

If you point the plugin at a remote endpoint, the contents of notes the agent reads are sent to that service. Use a local model (Ollama/LM Studio) to keep everything offline. The plugin makes no other network calls and has no telemetry.

## Development

```bash
npm install
npm run dev      # watch build
npm run build    # type-check + production bundle
npm run lint
```

To test in a vault, copy `main.js`, `manifest.json`, and `styles.css` into
`<Vault>/.obsidian/plugins/ai-vault-chat/` and enable the plugin under
**Settings → Community plugins**. (For local development the plugin folder name
should match the `id` in `manifest.json`.)
