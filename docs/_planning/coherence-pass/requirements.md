# Requirements: a coherence pass over structure and docs

Design: [design.md](design.md)

This is the third and last tier of a review pass. The first two tiers — four
defects with their dead code, and the panel's integration with Obsidian — are
already on this branch and are not restated here. What is left is everything
that needs a module to move, a file to split, or a page to be written, which is
what principle 1 says cannot happen without this document.

## 1. Why this exists

The plugin's per-module documentation is good: nearly every file opens with a
doc comment stating its purpose, its boundary, and the alternatives that lost.
Principle 4 is satisfied. What is missing is everything *above* a single file.

- `docs/` holds no `README.md` and no `architecture.md`, so there is no map of
  a 10,000-line codebase and no statement of which way its dependencies run.
  Principle 5 prescribes both by name.
- Two shipped plans are still sitting in `docs/` as plans —
  `rag-and-wiki-plan.md` ("Draft for review") and `agent-workflows-plan.md`
  ("Approved"). Both describe work that has landed. Principle 1 says to fold
  what is durable into the permanent docs and delete the rest; that step was
  skipped twice.
- `docs/_planning/obsidian-integration/` (66 KB across three files) is likewise
  complete: every code task in its `tasks.md` is checked off. The two unchecked
  items are acceptance runs that need Obsidian and a live endpoint, so they are
  not code work and do not keep the directory alive.

Separately, three module boundaries say something untrue about the code:

- `inFolder` — the "is this path inside that folder" predicate — lives in
  `tools/graph.ts`, the wiki and link-graph module, and is imported from there
  by the text search and the semantic indexer. `permissions.ts` has its own
  private copy of the same logic in `underAny`.
- `settings.ts` is 1,122 lines: the settings shape, ~90 lines of system-prompt
  prose, and a 700-line settings *tab* — a UI class living outside `ui/`, where
  every other view lives.
- `tools/vault-tools.ts` is 915 lines, of which ~330 are a static array of tool
  schemas. What the model is told and what happens when it calls are two
  different concerns in one file.

AGENTS.md asks for files under ~200–300 lines and for "clear module
boundaries". These three are the places where that is furthest from true, and
in each case the line count is a symptom rather than the problem.

## 2. What must be true when this is done

1. `docs/README.md` exists and reaches every other page in `docs/`.
2. `docs/architecture.md` states the component map, the data flow through one
   message and one workflow round, and the direction dependencies may run.
3. No document in `docs/` describes work as planned when it has shipped.
   `docs/_planning/` is empty of completed work.
4. Nothing durable from the deleted plans is lost — specifically the decisions
   each one records and the reasons they were made.
5. Every page links back to `docs/README.md`, with relative links only.
6. One implementation of "is this path inside that folder", in a module both
   the permission checks and the retrieval code can depend on without a cycle.
7. `settings.ts` describes settings. The settings tab is a view under `ui/`.
   The system-prompt prose is neither.
8. The tool schemas the model receives are separable from the dispatch that
   runs them.
9. `README.md` and `AGENTS.md` still describe the plugin accurately afterwards.
10. `npm run build` and `npm run lint` pass, as they do now.

## 3. Non-goals

- **No behaviour change.** A user must not be able to tell this tier happened.
  Every item is a move, a split, a deletion, or a page.
- **No settings-key renames.** `researchFolder`, `researchDefaultRounds` and
  `researchDefaultDelaySeconds` are named for a feature that was generalised
  into workflows, and the UI and README already call them runs and workflows.
  Renaming them buys internal readability at the cost of migration code that
  must live forever, and it is the one change in this tier that can lose a
  user's configuration if it goes wrong. Principle 2 asks for the named
  requirement that forces the complexity; there is none.
- **No new tests or test harness.** The repo has none, and adding one is its
  own change with its own plan.
- **No page per source file.** Principle 5 puts per-file explanation in module
  doc comments, and this codebase already does that well.

## 4. Acceptance

- `npm run build` and `npm run lint` pass.
- Every relative link in `docs/` resolves to a file that exists.
- `git grep` finds no import of `inFolder` from `tools/graph`.
- No file in `docs/` outside `_planning/` describes shipped work in the future
  or conditional tense.
- Loading the built plugin in a vault still opens the panel, answers a message,
  and runs a workflow — unchanged, because nothing about behaviour moved.

---

Repository README: [../../../README.md](../../../README.md)
