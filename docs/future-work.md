# Future work

Things deliberately left out of a change, with enough of the argument to start
from rather than rediscover. Nothing here is committed to; it is the record of
what was considered and why it was not done yet.

## Link autocomplete in the chat composer

**What it would give.** Typing `[[` in the chat box would offer notes and their
headings, the way it does in a note. The plugin already resolves the `[[links]]`
you type (see the README's *Links you type are resolved*), and typing a bare
filename is enough — but you still have to know the name, and a mistyped one
costs a round trip even though the panel names the closest note.

**Why it is not done.** Obsidian's own link suggester is an
[`EditorSuggest`](https://docs.obsidian.md/Reference/TypeScript+API/EditorSuggest),
registered with `registerEditorSuggest` and driven by the CodeMirror editor's
cursor. It runs inside a markdown editor and nowhere else, so it cannot appear
in the panel.

The sanctioned way to attach a suggester to something outside the editor is
`AbstractInputSuggest`, and its constructor is the obstacle:

```ts
constructor(app: App, textInputEl: HTMLInputElement | HTMLDivElement);
```

The composer is a `<textarea>` (`src/ui/chat-view.ts`), which is neither.
Casting one through is not safe in the way it looks: the class accepts either an
`<input>` or a contenteditable `<div>`, so it must branch on which it was given,
and a textarea landing in the contenteditable branch would read `textContent`
where it needs `value`. That is a bet on implementation details that are not
visible from the typings.

**What it would take.** One of:

1. **Move the composer to a contenteditable `<div>`.** Supported by the
   constructor, so the suggester itself becomes small. The cost is everything
   that currently assumes a textarea: `fitToContent` in `src/ui/autogrow.ts`,
   `.value` reads and writes in `send()`, Enter-to-send versus Shift+Enter,
   the placeholder, and paste-as-plain-text (a contenteditable div will happily
   accept pasted HTML).
2. **Write a small suggester.** Roughly a positioned popover, a filtered list,
   keyboard navigation and an insert-at-cursor splice — call it 120 lines. The
   `obsidianmd/prefer-abstract-input-suggest` lint rule objects only to the
   widely-copied `createPopper`-based `TextInputSuggest`, not to the idea, so a
   plain implementation is fine.

Either way the data is already available: `vault.getMarkdownFiles()` for notes
and `metadataCache.getFileCache(file).headings` for the `#section` half. There
is no public equivalent of Obsidian's internal `getLinkSuggestions`, so the list
would be built from those two.

Option 1 is the better end state and the larger change. Option 2 is contained
and reversible.

## Tool calling: what the model can do, and what the tool list costs

Two separate things get conflated as "small models are bad at tools". They come
apart, and only one of them is about size.

### Whether the model was trained to call tools at all

The chat template decides this, not the parameter count. A model whose template
declares a tool-call format emits structured calls that an OpenAI-compatible
endpoint parses directly. A model without one can still be prompted into it —
the schemas go in the prompt and JSON is parsed back out of the reply — but that
path is looser, and it is where malformed and hallucinated calls come from.

Among the models this plugin is used with, Qwen3 ships explicit tool-call
training and a tool section in its template; Gemma 3 does not ship native
tool-call tokens, and llama.cpp falls back to a generic format for it. Expect
the same tool set to behave noticeably differently between them. This moves
between releases, so check the template actually in use (llama.cpp's `--jinja`)
rather than trusting this paragraph.

**The practical lever** is constrained decoding: llama.cpp with `--jinja` and a
tool-declaring template constrains tool-call output with a grammar, which
removes malformed calls rather than reducing them. There is nothing to build
here — it is a matter of running the endpoint that way — but it is the first
thing to try if a model is producing calls that do not parse.

### What the tool list costs in context

Every request carries every tool's schema. Measured on this plugin's built-in
set, serialized as the wire format sees it:

| | tools | ≈ tokens |
| --- | --- | --- |
| before the Obsidian-integration change | 13 | ~1,600 |
| after it | 20 | ~3,100 |

Roughly 10% of a 32k context window, spent on every request whether the
conversation needs any of it, before a single MCP server is connected. It sits
in the cached prefix so it costs little *time*; the space is simply gone. The
panel's context ring shows the total, which is where this becomes visible.

Descriptions are most of that weight, and they are not padding — a description
that says *when* to reach for a tool ("prefer this to `read_file` when you know
the heading") is what stops the wrong one being picked, and description quality
matters more than tool count for selection accuracy. So the trade is real:
shorter schemas buy context and cost accuracy.

**Things worth trying, if it starts to bite:**

- **Measure before changing anything.** The prompt set below has one correct
  first tool call each; score first-call accuracy and rounds-to-answer at
  different tool counts on the models actually in use. Everything else here is
  speculation until that number exists.
- **Tool groups behind a setting.** `activeToolSpecs` already drops tools by
  setting, and workflow steps already take a `tools` allowlist, so the machinery
  exists — what is missing is only a way to say "I do not use the wiki" and get
  four schemas back. Cheap, but a knob, so it wants evidence first.
- **Two-tier tools**: a small always-present set plus a `capabilities`-style
  call that reveals the rest on demand. Discovery does not remove schemas from
  the prompt, so this only helps if the second tier is genuinely absent until
  asked for — which costs a round trip and a lot of machinery.
- **Shorter descriptions with the guidance moved into the system prompt.** Moves
  the tokens rather than removing them, but the system prompt is one block
  instead of twenty, so there is some duplication to win back.

### A tool-selection prompt set

Each has one correct first call. Useful before and after any change to the tool
list.

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

## Smaller things, with the reason each was left

- **Delete and copy.** `FileManager.trashFile` respects the user's trash
  preference and is a one-line call; `Vault.copy` needs `minAppVersion` raised
  to 1.8.7. Deletion is the operation with no undo inside the plugin's model of
  the vault, and the file explorer is two clicks away. If delete is ever added
  it should report what it moved and where trash is, the way `move_file` reports
  links.
- **A frontmatter tool** over `FileManager.processFrontMatter`. Edits properties
  without a whole-file rewrite and cannot mangle YAML, which whole-file writes
  by small models absolutely can. The strongest candidate of anything on this
  page.
- **Open or reveal a note in Obsidian** (`workspace.getLeaf().openFile`). The
  first tool that would act on the *interface* rather than the vault — a new
  category with no analogue in the current permission model, which is about
  files. Wants its own thinking about what "approval" means for it.
- **A vault-wide broken-link report.** `list_wiki` does this for the wiki and
  `links` per note. Vault-wide is a maintenance feature that wants a view, not
  a tool result.
- **Recently-modified notes** (`TFile.stat.mtime`, no file reads). Cheap, and
  answers "what have I been working on". Nothing has needed it yet.
- **Line-range and patch editing.** `write_section` covers editing part of a
  note using an anchor Obsidian already defines. Patch application needs its own
  ambiguity handling and its own failure modes.

---

Repository README: [../README.md](../README.md)
