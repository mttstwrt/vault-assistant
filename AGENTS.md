# Obsidian community plugin

## Project overview

- Target: Obsidian Community Plugin (TypeScript → bundled JavaScript).
- Entry point: `src/main.ts` compiled to `main.js` and loaded by Obsidian.
- Required release artifacts: `main.js`, `manifest.json`, and optional `styles.css`.

## Environment & tooling

- Node.js: use current LTS (Node 18+ recommended).
- **Package manager: npm** (required for this sample - `package.json` defines npm scripts and dependencies).
- **Bundler: esbuild** (required for this sample - `esbuild.config.mjs` and build scripts depend on it). Alternative bundlers like Rollup or webpack are acceptable for other projects if they bundle all external dependencies into `main.js`.
- Types: `obsidian` type definitions.

**Note**: This sample project has specific technical dependencies on npm and esbuild. If you're creating a plugin from scratch, you can choose different tools, but you'll need to replace the build configuration accordingly.

### Install

```bash
npm install
```

### Dev (watch)

```bash
npm run dev
```

### Production build

```bash
npm run build
```

## Linting

- ESLint is preconfigured with `eslint-plugin-obsidianmd` for Obsidian-specific rules.
- Run `npm run lint` to lint the project.
- A GitHub Action automatically lints every commit on all branches.

## File & folder conventions

- **Organize code into multiple files**: Split functionality across separate modules rather than putting everything in `main.ts`.
- Source lives in `src/`. Keep `main.ts` small and focused on plugin lifecycle (loading, unloading, registering commands).
- **Example file structure**:
    ```
    src/
      main.ts           # Plugin entry point, lifecycle management
      settings.ts       # Settings interface and defaults
      commands/         # Command implementations
        command1.ts
        command2.ts
      ui/              # UI components, modals, views
        modal.ts
        view.ts
      utils/           # Utility functions, helpers
        helpers.ts
        constants.ts
      types.ts         # TypeScript interfaces and types
    ```
- **Do not commit build artifacts**: Never commit `node_modules/`, `main.js`, or other generated files to version control.
- Keep the plugin small. Avoid large dependencies. Prefer browser-compatible packages.
- Generated output should be placed at the plugin root or `dist/` depending on your build setup. Release artifacts must end up at the top level of the plugin folder in the vault (`main.js`, `manifest.json`, `styles.css`).

## Manifest rules (`manifest.json`)

- Must include (non-exhaustive):
    - `id` (plugin ID; for local dev it should match the folder name)
    - `name`
    - `version` (Semantic Versioning `x.y.z`)
    - `minAppVersion`
    - `description`
    - `isDesktopOnly` (boolean)
    - Optional: `author`, `authorUrl`, `fundingUrl` (string or map)
- Never change `id` after release. Treat it as stable API.
- Keep `minAppVersion` accurate when using newer APIs.
- Canonical requirements are coded here: https://github.com/obsidianmd/obsidian-releases/blob/master/.github/workflows/validate-plugin-entry.yml

## Testing

- Manual install for testing: copy `main.js`, `manifest.json`, `styles.css` (if any) to:
    ```
    <Vault>/.obsidian/plugins/<plugin-id>/
    ```
- Reload Obsidian and enable the plugin in **Settings → Community plugins**.

## Commands & settings

- Any user-facing commands should be added via `this.addCommand(...)`.
- If the plugin has configuration, provide a settings tab and sensible defaults.
- Persist settings using `this.loadData()` / `this.saveData()`.
- Use stable command IDs; avoid renaming once released.

## Versioning & releases

- Bump `version` in `manifest.json` (SemVer) and update `versions.json` to map plugin version → minimum app version.
- Create a GitHub release whose tag exactly matches `manifest.json`'s `version`. Do not use a leading `v`.
- Attach `manifest.json`, `main.js`, and `styles.css` (if present) to the release as individual assets.
- After the initial release, follow the process to add/update your plugin in the community catalog as required.

## Security, privacy, and compliance

Follow Obsidian's **Developer Policies** and **Plugin Guidelines**. In particular:

- Default to local/offline operation. Only make network requests when essential to the feature.
- No hidden telemetry. If you collect optional analytics or call third-party services, require explicit opt-in and document clearly in `README.md` and in settings.
- Never execute remote code, fetch and eval scripts, or auto-update plugin code outside of normal releases.
- Minimize scope: read/write only what's necessary inside the vault. Do not access files outside the vault.
- Clearly disclose any external services used, data sent, and risks.
- Respect user privacy. Do not collect vault contents, filenames, or personal information unless absolutely necessary and explicitly consented.
- Avoid deceptive patterns, ads, or spammy notifications.
- **This plugin's network egress**: chat sends the notes the agent reads to the configured model endpoint; the opt-in semantic search feature additionally sends indexed note contents to the configured embeddings endpoint. Both are documented in `README.md`. Any new feature that transmits vault contents must be opt-in, disclosed there, and must respect the read-block list (`isReadable`).
- Register and clean up all DOM, app, and interval listeners using the provided `register*` helpers so the plugin unloads safely.

## UX & copy guidelines (for UI text, commands, settings)

- Prefer sentence case for headings, buttons, and titles.
- Use clear, action-oriented imperatives in step-by-step copy.
- Use **bold** to indicate literal UI labels. Prefer "select" for interactions.
- Use arrow notation for navigation: **Settings → Community plugins**.
- Keep in-app strings short, consistent, and free of jargon.

## Performance

- Keep startup light. Defer heavy work until needed.
- Avoid long-running tasks during `onload`; use lazy initialization.
- Batch disk access and avoid excessive vault scans.
- Debounce/throttle expensive operations in response to file system events.

## Coding conventions

- TypeScript with `"strict": true` preferred.
- **Keep `main.ts` minimal**: Focus only on plugin lifecycle (onload, onunload, addCommand calls). Delegate all feature logic to separate modules.
- **Split large files**: If any file exceeds ~200-300 lines, consider breaking it into smaller, focused modules.
- **Use clear module boundaries**: Each file should have a single, well-defined responsibility.
- Bundle everything into `main.js` (no unbundled runtime deps).
- Avoid Node/Electron APIs if you want mobile compatibility; set `isDesktopOnly` accordingly.
- Prefer `async/await` over promise chains; handle errors gracefully.

## Mobile

- Where feasible, test on iOS and Android.
- Don't assume desktop-only behavior unless `isDesktopOnly` is `true`.
- Avoid large in-memory structures; be mindful of memory and storage constraints.

## Agent do/don't

**Do**

- Add commands with stable IDs (don't rename once released).
- Provide defaults and validation in settings.
- Write idempotent code paths so reload/unload doesn't leak listeners or intervals.
- Use `this.register*` helpers for everything that needs cleanup.

**Don't**

- Introduce network calls without an obvious user-facing reason and documentation.
- Ship features that require cloud services without clear disclosure and explicit opt-in.
- Store or transmit vault contents unless essential and consented.

## Common tasks

### Organize code across multiple files

**main.ts** (minimal, lifecycle only):

```ts
import { Plugin } from 'obsidian';
import { MySettings, DEFAULT_SETTINGS } from './settings';
import { registerCommands } from './commands';

export default class MyPlugin extends Plugin {
	settings!: MySettings;

	async onload() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<MySettings>,
		);
		registerCommands(this);
	}
}
```

**settings.ts**:

```ts
export interface MySettings {
	enabled: boolean;
	apiKey: string;
}

export const DEFAULT_SETTINGS: MySettings = {
	enabled: true,
	apiKey: '',
};
```

**commands/index.ts**:

```ts
import { Plugin } from 'obsidian';
import { doSomething } from './my-command';

export function registerCommands(plugin: Plugin) {
	plugin.addCommand({
		id: 'do-something',
		name: 'Do something',
		callback: () => doSomething(plugin),
	});
}
```

### Add a command

```ts
this.addCommand({
	id: 'your-command-id',
	name: 'Do the thing',
	callback: () => this.doTheThing(),
});
```

### Persist settings

```ts
interface MySettings { enabled: boolean }
const DEFAULT_SETTINGS: MySettings = { enabled: true };

async onload() {
  this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<MySettings>);
  await this.saveData(this.settings);
}
```

### Register listeners safely

```ts
this.registerEvent(
	this.app.workspace.on('file-open', (f) => {
		/* ... */
	}),
);
this.registerDomEvent(activeWindow, 'resize', () => {
	/* ... */
});
this.registerInterval(
	window.setInterval(() => {
		/* ... */
	}, 1000),
);
```

## Troubleshooting

- Plugin doesn't load after build: ensure `main.js` and `manifest.json` are at the top level of the plugin folder under `<Vault>/.obsidian/plugins/<plugin-id>/`.
- Build issues: if `main.js` is missing, run `npm run build` or `npm run dev` to compile your TypeScript source code.
- Commands not appearing: verify `addCommand` runs after `onload` and IDs are unique.
- Settings not persisting: ensure `loadData`/`saveData` are awaited and you re-render the UI after changes.
- Mobile-only issues: confirm you're not using desktop-only APIs; check `isDesktopOnly` and adjust.

## References

- Obsidian sample plugin: https://github.com/obsidianmd/obsidian-sample-plugin
- API documentation: https://docs.obsidian.md
- Developer policies: https://docs.obsidian.md/Developer+policies
- Plugin guidelines: https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines
- Style guide: https://help.obsidian.md/style-guide

## Engineering Principles

These are ordered. When they conflict, the earlier one wins.

### 1. Plan before you build

Thinking is cheap in a plan and expensive once it's code — catch a wrong
assumption or a bad approach before anything is written, not after.

**No code changes without a written, approved plan.** No size exception —
depth scales with the change instead: a typo fix might be one sentence, a new
subsystem a paragraph per section. A short plan is the rule working, not a
workaround.

**Record the plan** in chat if nothing about the change would trigger the
update rules in principle 5 (no new or changed subsystem, interface, or data
flow). Otherwise record it as `docs/_planning/<slug>/requirements.md` and
`design.md` (layout in principle 5). Either way, answer in writing before
presenting for approval:

- **Approach** — what you're going to do.
- **Alternatives** — what else could work, and why each one lost.
- **Impact** — what this touches, what could break, what depends on it.
- **Assumptions** — what you're taking on faith, and what happens if it's wrong.

**Review it — independently when you can.** A subagent or fresh session scoped
to just the plan catches what self-review won't; use one if available.
Otherwise review it yourself, adversarially. Fix what you find.

**Get explicit approval** before creating `tasks.md` or touching code. Revise
and re-present on feedback — silence isn't approval.

**Disclose every departure** from the approved plan when you report progress.
Stop and get approval if a departure leaves any of the four questions above
without a confident answer.

**On completion**, fold what's durable into the permanent docs (principle 5)
and delete `docs/_planning/<slug>/`, if one exists. Git history is the record
of what was tried.

### 2. Simplest thing that works

Complexity must be earned by a demonstrated need, not an anticipated one. The
simplest solution that satisfies the requirement is correct.

- One function beats a class; one class beats a hierarchy; a hierarchy beats a
  framework.
- No abstraction, interface, or plugin point for a single implementation — write
  the concrete thing, and extract the abstraction on the second real use case.
- No config option, flag, or parameter that wasn't asked for. Every knob is a
  permanent maintenance surface and a test case.
- No error handling for conditions that can't occur, no defensive checks for
  invariants the type system already guarantees, no retries without a transient
  failure mode.
- Standard library over a new dependency; an existing dependency over a new one.
  Justify any addition by what it removes.
- Deletion is a valid fix. If a change orphans code, remove it in the same change
  — don't comment it out.

Complexity needs a named requirement. If you can't name the one that forces it,
write the simple version.

### 3. Performance is a design property, not a pass at the end

Think about cost where it's expensive to change later: algorithmic complexity,
allocation patterns, I/O and syscall boundaries, data layout, work per iteration
of a hot loop. Get these right the first time.

Don't micro-optimize, don't restructure readable code for speculative gains, and
don't trade clarity for performance without a measurement showing the trade is
real — unmeasured optimization is complexity without justification (principle 2).

When a fast path needs complexity, isolate it: one clearly marked place, behind a
simple interface, with a comment naming the measurement that motivated it.

### 4. Comments explain why

A comment carries what the code can't recover on its own.

- Rationale, constraints, and rejected alternatives — not mechanics. If a comment
  restates the line below it, delete it.
- Non-obvious decisions: why this algorithm, this ordering, this buffer size,
  this apparent inefficiency.
- Invariants, caller assumptions, and units/frames/coordinate conventions on
  anything numeric.
- Anything surprising — if a future reader would be tempted to "fix" it, say why
  it's that way.
- Every module gets a doc comment stating its purpose and boundaries. That's
  where per-file explanation lives, not `docs/`.

### 5. Keep the docs current

`docs/` describes how the system works now, and why. It's part of every change,
not a follow-up.

**Layout**

```
docs/
  README.md              entry point; links to every subsystem
  architecture.md         component map, data flow, dependency direction
  _planning/<slug>/       active feature plans (principle 1); not part of this tree
  <subsystem>/
    README.md             subsystem overview
    <topic>.md             only when a topic outgrows the README
```

**Granularity.** Pages describe subsystems, not files. Give a component its own
directory when it has its own responsibility and interface — not one page per
source file. Split a topic out of a README only when it would otherwise dominate
it. Per-file explanation belongs in module doc comments (principle 4).

**Every subsystem README covers:** responsibility, explicit non-responsibility,
public interface, dependencies (named, not implied by nesting), dependents, and
the invariants callers must uphold.

**Linking.** Relative markdown links only. Every page links back to
`docs/README.md` and to the subsystems it names — nothing should be reachable
only by browsing the filesystem.

**Update rules.** In the same change:
- add, remove, rename, or move a subsystem → update `architecture.md` and its
  links
- change a data flow, interface contract, or file/wire format → update the
  subsystem READMEs on both sides
- code contradicts what the docs say → fix the docs

Prose over bullet fragments. Link to code instead of pasting it — it will drift.
An outdated doc is a bug; fix it in the same change that caused it.
