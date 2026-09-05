# Vault assistant

A minimalist AI chat panel for [Obsidian](https://obsidian.md) that gives a language model access to your vault the way a coding agent (Claude Code, opencode) sees a repository — it can list, search, read, and (only where you allow it) write notes.

It works with any **OpenAI-compatible** endpoint: local runners like **Ollama** and **LM Studio**, or hosted APIs like OpenAI and OpenRouter.

## A note on privacy

If you point the plugin at a remote endpoint, the contents of notes the agent reads are sent to that service. While **Expand [[links]] you type** is enabled (the default), a `[[link]]` you type in the chat box also sends that note's text with your message — you asked for it by naming it, blocked folders are never attached, and the panel lists everything that was, but it is content leaving because you typed a link rather than because the agent chose to read a file. While **See what you have open** is enabled (the default), the *paths* of your open tabs are also sent with each message so the agent knows what you are looking at — paths inside blocked folders are excluded, and the setting turns the whole thing off. Use a local model (Ollama/LM Studio) to keep everything offline. If you enable **semantic search** (off by default), the notes being indexed are additionally sent to the embedding endpoint — use a local embedding model (e.g. `nomic-embed-text` on Ollama) to keep that offline too. Folders you block from reading are never indexed and never sent anywhere. If you enable **Let the model file conversations into folders** (off by default), the names of the subfolders in your conversations folder are sent with that same naming call, so the model can reuse a folder rather than invent one. Opening the plugin's settings also asks your configured endpoint which models it serves (a `GET /v1/models`, so the model dropdown can be filled in) — that request carries no note contents. The plugin makes no other network calls and has no telemetry. Note that a **workflow run** keeps calling your model endpoint unattended until it pauses or you stop it — on a paid API, set a rounds budget and keep an eye on cost.

The optional **conversation import** processes everything locally and only when you explicitly run it: the Claude Code source (desktop only) reads session logs from your local `~/.claude` directory — files outside your vault — and the claude.ai/ChatGPT sources read only the export file you pick. Nothing the importer reads leaves your machine; it just writes cleaned transcripts into your conversations folder.

## Features

- **Chat side panel** — open from the ribbon (bot icon) or the command **Vault assistant: Open chat**. Answers **stream in** as they are written, with a collapsible **thinking** section for reasoning models that ticks while the model works and folds itself into "Thought for 4.2s" when the answer starts. **Ctrl+C** (or the Stop button, or the command **Stop the current response**) cuts a long answer off mid-sentence and keeps what you got. The composer **grows as you type** (up to 40% of the panel), all output is selectable and copyable — with a copy button on every message — and scrolling up detaches the view so you can read while the rest streams in. When the endpoint reports them, generation speed and token counts appear under the answer. A **context ring** in the header fills as the conversation grows — hover it for `12,431 / 32,768 tokens · 38% used` — and turns amber past 80%, red past 95%. Beside it, a **model dropdown** lists what your endpoint advertises and names the one that is answering; on a llama.cpp router it also says which models are loaded, since picking one that isn't means the next message waits for weights. On desktop, the pop-out button moves the panel into its own window — the open conversation follows it there, and the panel returns to whatever conversation it was showing when Obsidian restarts (a saved transcript is how it travels, so an unsaved conversation starts fresh in the new window — press save first).
- **Vault-aware agent** — the model is given tools to explore your notes and ground its answers in them:
  - `list_files` (any depth), `read_file`, `search`
  - `outline` — a note's heading tree, frontmatter keys and counts, with none of its prose
  - `read_section` — one heading's section (subheadings included) or one `^block`, instead of the whole note
  - `tags` — every tag with counts, or the notes carrying one, read from Obsidian's index rather than by scanning text
  - `semantic_search` — embedding-based recall (when semantic search is enabled)
  - `links` — outgoing links and backlinks for any note
  - `open_files` — what you have open in Obsidian and which note is focused
  - `write_file`, `append_file`, `write_section` (writable folders only)
  - `move_file`, `create_folder` — move or rename through Obsidian itself, and make folders
  - `capabilities` — what it can actually do here, read from your live settings
  - `wiki_home`, `wiki_page` — enter the wiki at its curated Home page and hop through it by `[[links]]`
  - `list_wiki` — the wiki sitemap (all pages, their links, orphans and broken links)
  - `update_wiki` — create or expand an interlinked wiki note
  - `remember` — save a durable fact to the agent's operating memory

  `search` is grep, not a substring scan: regular expressions, `path:line:` hits, several per file, an optional folder to scope to, and the usual flags (`-i`, `-w`, `-v`, `-C`, `-l`, plus a multiline mode). It stays in-process rather than shelling out, because this plugin also runs on mobile, where there is no shell — and because your blocked folders are safer enforced by the same function every other tool calls than by `--exclude-dir` arguments.

  Models trained as coding agents tend to try a shell first — `ls`, `cat`, `grep`, an absolute file path — and waste rounds discovering none of it exists. The system prompt states the boundary up front (no shell, no filesystem, vault-relative paths, and the tools available this turn), a read-only call under a familiar name is simply run as its vault equivalent, and anything that could change a file gets a correction naming the right tool instead of a dead end. Sloppy paths are accepted too: `/home/you/Vault/Notes/Ideas.md`, `C:\…`, `./Notes/Ideas`, or a filename with the wrong case all resolve, and a path that still doesn't match comes back with the closest notes named.
- **Knows what it can do** — ask "if you move a note, will the links update?" and you get this vault's answer, not a guess: the agent reads your Obsidian settings and tells you whether **Automatically update internal links** is on, off (in which case it warns you before moving anything), or unreadable. The same `capabilities` call reports the tools it has this turn and what each really does, which folders it may read and write, and what is genuinely impossible here — no shell, no network, no deleting. Generated from live settings each time it is asked, so it cannot drift out of date.
- **Moves notes the way you would** — `move_file` goes through Obsidian's own rename, the same code path as dragging a note in the file explorer, so `[[links]]` follow. It moves folders too, needs write permission at both ends, and shows you both paths on an approval card before touching anything outside your writable folders. Afterwards it counts the backlinks again and tells you the truth: *"6 notes linked to it, and all 6 now point at the new path"* — or which ones did not, if you have link updating switched off. And there is a `create_folder`, so it stops building folders out of placeholder notes it cannot delete.
- **Edits part of a note, not all of it** — `outline` shows a long note's heading tree without its prose, `read_section` pulls one heading's section, and `write_section` puts one back, leaving every other byte alone. Sections are resolved by the same function Obsidian uses for `[[note#heading]]`, so a section means here exactly what it means in the app. Appends go through Obsidian's atomic write, so editing a note while the agent is writing to it no longer loses whichever of you finished second.
- **Links you type are resolved** — write `[[Ideas]]` or `[[Ideas#Chunking]]` in the chat box and the note (or just that section) is attached to your message before it is sent, so the agent does not spend a tool round fetching what you just named. Typing the filename is enough — no folder path — and aliases work, because it is Obsidian's own link resolution. Links inside code blocks are ignored, blocked folders are never attached, a long message attaches what fits and names the rest, and a link that matches nothing tells you so and names the closest note (`[[Idaes]]` finds `Ideas`). Everything attached is listed under your message, so nothing is sent invisibly. Turn it off with **Expand [[links]] you type**.
- **Knows what you're looking at** — the agent sees which notes are open in Obsidian and which one is focused, refreshed before every message you send. So "what am I looking at?", "summarise this", or "add a task to this note" just work, with no need to name the file (and it can re-check mid-answer with `open_files`). Open tabs in blocked folders are never listed; if the note you're focused on is blocked, the agent is told only that it can't see it, so it says so instead of answering about the wrong note. Turn the whole thing off with **See what you have open**.
- **Model discovery** — the plugin asks your endpoint which models it serves and offers them as a dropdown when there is more than one, for both the chat model and the embedding model, so you don't have to remember exact names like `text-embedding-nomic-embed-text-v1.5`. Works with anything OpenAI-compatible: llama.cpp (one entry for a loaded model, the full list when it runs as a router), Ollama, LM Studio, OpenAI, OpenRouter. Endpoints that don't answer say so and leave the text field, which always takes a hand-typed name.
- **See every write as a diff** — when the agent writes a note, the panel shows what changed: green `+` lines, red `−` lines, a few lines of context, and the added/removed counts in the header. Small changes are expanded, larger ones collapse behind their counts, and a wholesale replacement of a very large note is summarised rather than drawn. When a write needs your approval, the same diff appears **on the approval card**, so you decide on the actual change rather than just a path — and once you allow it, that card becomes the record of the write instead of a second copy of the diff. The diff is for you only: the model still just gets "Updated Notes/Ideas.md", so your context window doesn't pay for it.
- **Folder-scoped permissions** — decide exactly what the agent may read and write. By default it can read everything but write **nothing** except the conversations, wiki, and memory files, so your own notes stay untouched.
- **Saved conversations, sorted** — every chat is written to your conversations folder as a markdown note, named from the date and time plus a title the model picks after the first exchange (`2026-08-12 1432 Reworking the RAG chunker.md`), so the folder stays browsable. Reopen any saved conversation from the panel's history button and keep talking; new turns are appended to the same note. Turn **auto-save** off and nothing is written until you press the panel's **save** button — which saves the conversation you are in, and keeps saving that one as it grows. Turn **filing** on (off by default) and the same call that titles a conversation also says which folder under your conversations folder it belongs in, creating it if needed, so a year of chatting sorts by subject instead of only by date. The folders you already have are put in front of the model to reuse, which is what keeps a folder from filling up with `Coding`, `Programming` and `Dev`; conversations are filed once, when first saved, and never moved afterwards.
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
| Model | Model name your endpoint expects, e.g. `llama3.1`, `gpt-4o-mini`. Models your endpoint advertises are detected when you open these settings and offered as a dropdown when there is more than one; the refresh button next to the field looks again after you change the URL. Typing a name always works, whatever was detected. The chat panel's header offers the same list, and picking there sets this. |
| Temperature | Sampling temperature. |
| Presence penalty | −2 to 2, 0 = off. Sent as `presence_penalty`. Discourages reusing anything already said; a small positive value helps a model that keeps circling the same phrasing. |
| Repetition penalty | 1 = off; 1.05–1.2 is the useful range. Sent as **both** `repeat_penalty` (llama.cpp) and `repetition_penalty` (vLLM, TGI) — an endpoint ignores the name it doesn't use. The usual fix for a model that gets stuck repeating itself or thinking in circles. |
| Max tool steps | How many tool-call rounds the agent may take per message. |
| Send extra request parameters | Optional. Merge a JSON object into every chat request to enable server-side samplers your endpoint supports — e.g. llama.cpp's dynamic temperature (`dynatemp_range`, `dynatemp_exponent`) or mirostat. llama.cpp's OpenAI-compatible server accepts these; Ollama's OpenAI route ignores them (use a Modelfile there instead). |
| Stream responses | On by default. Shows the answer as it is written and lets you stop it mid-answer. Falls back to a single buffered request automatically if a stream can't be opened (some hosted APIs refuse in-app requests), so you can leave it on. |
| Show thinking as it happens | On by default. Keeps the thinking section expanded while a reasoning model works. Turn it off to keep reasoning collapsed until you open it. |

**Folder permissions**

| Setting | Description |
| --- | --- |
| Read scope | Entire vault, or only an allowlist of folders (e.g. your daily notes). |
| Writable folders | Folders the agent may create/edit files in. Empty = it never touches your own notes. |
| Conversations folder | Where transcripts are saved (always writable). Default `AI/Conversations`. |
| Wiki folder | Where the generated wiki lives (always writable). Default `AI/Wiki`. |
| Auto-save conversations | Save each chat as you go. Off = nothing is written until you press **save** in the chat panel; a conversation saved that way then keeps saving as it grows. |
| Let the model name conversations | On by default. The first time a conversation is saved, one cheap model call titles it, saved as `2026-08-12 1432 Reworking the RAG chunker.md`. Off = named after your first message, with no extra call. |
| Let the model file conversations into folders | **Off** by default. Also asks which folder under your conversations folder the transcript belongs in, and creates it if it doesn't exist. Folders you already have are offered to the model first, so the vocabulary settles instead of drifting. Shares the naming call when naming is on; costs one cheap call of its own when it isn't. Filed once, at the first save, and never moved afterwards. |
| See what you have open | On by default. Tells the agent which notes are open and which is focused (and exposes `open_files`), so "this note" resolves without naming a file. Blocked folders are never listed. |
| Expand [[links]] you type | On by default. Resolves `[[note]]` and `[[note#section]]` in your message and attaches the text before sending, so the agent doesn't spend a tool round fetching what you just named. Typing the filename is enough. Notes in blocked folders are never attached, and everything attached is listed under your message. |

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
| Embedding model | e.g. `nomic-embed-text` (Ollama), `text-embedding-3-small` (OpenAI). Detected the same way as the chat model, filtered to the embedding models the endpoint offers. |
| Embedding base URL / API key | Optional overrides; default to the chat endpoint and key. |
| Results per search | How many chunks `semantic_search` returns. |
| Index wiki pages | Also embed the wiki so search lands on curated pages. |
| Index conversations | Also embed saved chats, filtered to your messages + final answers. |
| Reindex now | Rebuild the index (also available as the command **Reindex vault for semantic search**). Unchanged chunks are skipped; edits reindex automatically afterwards. |

The conversations, wiki, and research folders and the memory file are always writable; everything else is read-only unless you add it to **Writable folders**.

## Troubleshooting

**A model gets stuck thinking in circles.** Small reasoning models can loop inside their own thinking and never reach an answer. Four things help, roughly in order:

1. **Repetition penalty** around 1.05–1.15 in settings. A loop is repetition, and this is the sampler aimed at it.
2. **Presence penalty** slightly positive, if the model circles the same idea in different words rather than repeating tokens exactly.
3. **`{"reasoning_effort": "none"}`** under **Send extra request parameters**, which llama.cpp honours by turning thinking off outright — or a lower level, if your model has one (see below).
4. **Ctrl+C**, which stops the answer and keeps whatever arrived — and the thinking section shows the elapsed time, so a loop is visible while it happens rather than after.

To hard-cap a runaway response, add `{"max_tokens": 2048}` under **Send extra request parameters**.

**The context ring says the size is unknown.** Nothing in the OpenAI schema reports a model's context window, so the ring needs an endpoint willing to volunteer it. llama.cpp does, at `GET /props` (`default_generation_settings.n_ctx`, the per-slot budget); Ollama, LM Studio and OpenAI do not, and the ring stays empty and counts tokens without a total rather than inventing one. On a llama.cpp router the question is asked per model and never loads one to answer it, so a model you have not used yet reports its window only once it is loaded.

The count itself is the newest answer's prompt plus its output, which is what the whole conversation costs to send — llama.cpp gives it as `prompt_n + cache_n + predicted_n`, and the reused-from-cache part is most of it after the first turn. It moves a turn at a time, so a long prompt shows the previous figure until its answer lands, and it includes the tool results the agent pulled in while answering.

**Choosing a reasoning effort is future work.** The panel used to offer a `reasoning_effort` selector, filled by reading the model's Jinja chat template from llama.cpp's `GET /props` and looking for level names inside it. That was a guess wearing a dropdown's clothes: a template can name a level in a branch that does nothing, accept one it silently ignores, or handle one it never spells out, and no endpoint says which happened. Nothing in the OpenAI schema enumerates the values `reasoning_effort` accepts, and llama.cpp hands the value to the chat template without claiming anything about it. Offering levels a model may not have is worse than offering none, so the selector is gone.

Bringing it back needs an endpoint that actually advertises the levels a model accepts — something to build against and test with, rather than infer. Until then the parameter is still yours to send: `{"reasoning_effort": "low"}` under **Send extra request parameters** reaches the wire exactly as the selector did.


**`ERR_INTERNET_DISCONNECTED` with a local model.** Obsidian is an Electron app, and Chromium refuses every network request while the operating system reports no active network interface — including requests to `127.0.0.1`, where the internet is irrelevant. A model server on the same PC should not care whether you are online, so requests to a loopback address (`localhost`, `127.0.0.1`, `::1`) that fail this way are retried over a direct connection that talks to the socket instead of going through Chromium. That covers chat, streaming, embeddings, and model discovery. It applies on desktop only; remote endpoints keep using Obsidian's own request path, with its proxy and certificate handling, and genuinely do need a network. If a local endpoint still fails after the retry, the error is about the server itself — check it is running and listening on the port in **Base URL**.

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

**Known toolchain issue: the TypeScript version is behind.** `tsconfig.json`
asks for `"moduleResolution": "node"` (node10). TypeScript 5.9 — what the
lockfile pins and what CI runs — accepts it, so the build passes; TypeScript 6
rejects it as deprecated (TS5107) *before* type-checking anything, and
TypeScript 7 removes it. So `npx tsc` with any compiler newer than the
lockfile's fails on the config rather than on the code, and the dependency
cannot be bumped until this changes. `"bundler"` is the setting that matches how
this project is actually built — esbuild resolves the imports, not tsc — and
`"ignoreDeprecations": "6.0"` buys time. Left for its own change.
