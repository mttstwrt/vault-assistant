# Design: a coherence pass over structure and docs

Requirements: [requirements.md](requirements.md)

## 1. Approach

Six changes, in an order where each one leaves the tree building. The module
moves come first, because the docs written afterwards should describe the tree
as it will be rather than as it was.

### 1.1 One `inFolder`

Move `inFolder` from `tools/graph.ts` to `permissions.ts` and express the
private `underAny` in terms of it.

`permissions.ts` is the right home rather than a neutral one because this
predicate *is* the permission model's primitive: "readable" and "writable" are
both defined as "inside one of these folders". Putting it anywhere else leaves
the rule stated twice.

It cannot go in `tools/paths.ts`, the other candidate, because `paths.ts`
imports `isReadable` from `permissions.ts` — a cycle. `permissions.ts` imports
nothing but `obsidian` and the settings type, so everything can depend on it.

Callers to update: `tools/graph.ts`, `tools/search.ts`, `rag/indexer.ts`.

### 1.2 The system prompt gets its own module

`DEFAULT_SYSTEM_PROMPT` and `LEGACY_SYSTEM_PROMPTS` move to a new
`src/system-prompt.ts` that imports nothing.

`prompts.ts` looks like the natural home and is not: it imports
`VaultAssistantSettings` from `settings.ts`, and `settings.ts` needs the
default prompt as a *value* to build `DEFAULT_SETTINGS`. That is a
module-initialisation cycle, not just a type one. A leaf module with no imports
cannot be in a cycle with anything.

The legacy array stays as literal text rather than becoming hashes. Hashing
would shrink the file, but the upgrade check is the only thing that reads it,
and a hash cannot be read by a person deciding whether a prompt was theirs.

### 1.3 The settings tab becomes a view

`VaultAssistantSettingTab` moves to `src/ui/settings-tab.ts`. `settings.ts`
keeps the settings interface, `McpServerConfig`, `DEFAULT_SETTINGS`, and
nothing else — about 230 lines. `main.ts` imports the tab from its new home.

### 1.4 Tool schemas separate from tool dispatch

`TOOL_SPECS` and `activeToolSpecs` move to `src/tools/specs.ts`.
`vault-tools.ts` keeps `ToolContext` and `executeTool` and imports the specs.

The boundary is real and not just a line count: `specs.ts` is what the model is
told it can do, and it is imported by `prompts.ts` and `capabilities.ts` purely
to enumerate names. `vault-tools.ts` is what happens when the model calls.
Today, asking "which tools exist" drags the whole dispatch in with it.

### 1.5 The docs tree

```
docs/
  README.md          entry point; what each page is for
  architecture.md    component map, the path of one message and one round,
                     dependency direction
  agent/README.md    the loop, the tool surface, the permission model
  retrieval/README.md  wiki, semantic index, pre-pass, typed links
  api/README.md      the OpenAI-compatible contract and what is assumed of it
  future-work.md     kept as is — it is already a durable record
```

**Four pages, not one per `src/` directory.** Principle 5 asks for a page per
subsystem and principle 4 puts per-file explanation in module doc comments,
which this codebase does thoroughly. A page for `ui/`, `mcp/`, `import/` or
`workflows/` would mostly restate doc comments that are already better than a
summary of them, and an outdated doc is a bug (principle 5's own words), so
each page is a liability that has to earn its keep. The three chosen have a
contract a caller must uphold and that no single file states:

- **agent** — what a tool may assume about permissions, what the approval flow
  guarantees, and why writes go through `Vault.process`. This is the contract
  every new tool has to honour, and today it is inferable only by reading four
  files.
- **retrieval** — the two-layer principle (cheap entry, lazy explore) that
  `rag-and-wiki-plan.md` argued for. It governs the wiki, the pre-pass, the
  typed-link inliner and the semantic index together, and no one file owns it.
- **api** — what the plugin assumes an endpoint provides, what it degrades to
  when the endpoint does not, and which of those assumptions are llama.cpp's
  rather than OpenAI's. This is the page a user debugging their endpoint wants.

Where these pages disagree with the two plans being deleted, the plans' durable
content — the decisions and their reasons — is folded in first. The plans'
status sections, task lists, and "where we are today" tables are not durable
and go.

### 1.6 Delete the finished plans

`docs/rag-and-wiki-plan.md`, `docs/agent-workflows-plan.md`, and
`docs/_planning/obsidian-integration/`, after 1.5 has absorbed what is durable.
Git history is the record of what was tried; principle 1 says so explicitly.

## 2. Alternatives

| Considered | Why it lost |
| --- | --- |
| Leave `docs/` alone | It is the repo's largest gap against its own rules, and the two stale plans actively mislead — one is still marked "Draft for review" for work that shipped. |
| A page per `src/` directory (seven) | Duplicates module doc comments that are already better, and every page is a thing that can go stale. Principle 2 beats principle 5 when they conflict. |
| Keep the plans, add a status banner | A plan with a banner is still a plan; readers would have two descriptions of the same subsystem and no way to know which is current. |
| `inFolder` into a new `src/paths.ts` | A new module for one four-line function, when the module that defines the concept already exists and can hold it. |
| `inFolder` into `tools/paths.ts` | Import cycle: `paths.ts` already depends on `permissions.ts`. |
| Prompt prose into `prompts.ts` | Module-initialisation cycle — `settings.ts` needs the default as a value. |
| Also rename the `research*` settings keys | Permanent migration code for internal readability only, and the one change here that can lose user configuration. Ruled out in requirements §3. |
| Context objects for `runAgent` (10 positional params) and `WorkflowRun` (8) | Deferred, see §5. |

## 3. Impact

- **Behaviour: none.** Every change is a move, a split, a deletion, or a page.
  No function changes what it does.
- **Imports change** in: `main.ts`, `prompts.ts`, `settings.ts`,
  `tools/graph.ts`, `tools/search.ts`, `tools/vault-tools.ts`,
  `tools/capabilities.ts`, `rag/indexer.ts`, plus the two new modules and the
  moved tab.
- **What could break:** a missed import after a move, which the build catches;
  a module-init cycle, which §1.2 and §1.5 are shaped to avoid and which
  esbuild would surface as an undefined value at load rather than at build —
  so the built bundle is loaded once before this is called done.
- **Nothing depends on the deleted docs** except `future-work.md`'s closing
  link to the repository README, which stays.
- **`README.md` and `AGENTS.md`** need a pointer to `docs/README.md`; neither
  currently mentions `docs/` at all.

## 4. Assumptions

- **The two plans have fully shipped.** Checked against the code: the wiki
  entry point, `wiki_home`/`wiki_page`, the semantic index, the workflow
  schema, runner, presets, canvas export and the scheduled runs all exist. If
  some corner of a plan turns out to be unbuilt, deleting the plan loses the
  argument for building it — so anything found unbuilt while folding moves to
  `future-work.md` rather than being dropped.
- **Nobody links to `docs/*-plan.md` from outside this repository.** They were
  never referenced in `README.md`, so a stale external link is the only risk,
  and git history still serves it.
- **No settings-key rename means no migration**, so a user's existing
  `data.json` keeps working untouched. This is what makes the tier safe to
  ship without a version bump.
- **The four doc pages will be read.** If they are not, they become the exact
  liability §1.5 argues against. The mitigation is that three of them state a
  contract a contributor has to know, rather than narrating what the code does.

## 5. Deferred

**Context objects for `runAgent` and `WorkflowRun`.** `runAgent` takes ten
positional parameters and `WorkflowRun`'s constructor eight; six of them are
the same six in both, and `runAgent` already builds a `ToolContext` out of its
first six arguments. Folding them into one object would make both call sites
self-documenting and stop a new dependency from being an arity change in three
files.

It is deferred rather than dropped because it is the only item in this tier
that rewrites a signature every caller uses, and it is worth landing on its own
so a bisect can find it. It is the first thing to do after this.

---

Repository README: [../../../README.md](../../../README.md)
