/**
 * Turning whatever a model calls a path into a vault path.
 *
 * Vault paths are relative to the vault root, but models offer absolute paths,
 * Windows separators, a leading vault name, quotes, and filenames without the
 * .md extension. Accepting those (and, when a file still can't be found,
 * naming the closest ones) saves a round of guessing every time.
 */
import { App, TFile, TFolder, normalizePath } from 'obsidian';
import { VaultAssistantSettings } from '../settings';
import { isReadable } from '../permissions';

/** How many near-misses to name when a path doesn't resolve. */
const MAX_SUGGESTIONS = 3;

/** Strip the decoration off a path and make it vault-relative. */
export function toVaultPath(app: App, raw: string): string {
	let p = raw.trim().replace(/^["'`]+|["'`]+$/g, '');
	p = p.replace(/^file:\/\//i, '');
	p = p.replace(/\\/g, '/');
	p = p.replace(/^[a-z]:\//i, ''); // C:/...
	p = p.replace(/^~\//, '');
	p = p.replace(/^(?:\.\/|\/)+/, '');

	// An absolute path usually ends in the vault: keep everything after the
	// vault's own folder name when it appears.
	const vault = app.vault.getName().toLowerCase();
	const parts = p.split('/');
	const at = parts.findIndex((seg) => seg.toLowerCase() === vault);
	if (at !== -1 && at < parts.length - 1) p = parts.slice(at + 1).join('/');

	return normalizePath(p.replace(/\/{2,}/g, '/'));
}

export interface NoteLookup {
	file: TFile | null;
	/** Vault paths worth trying instead, when nothing matched. */
	suggestions: string[];
	/** The cleaned-up path that was looked for. */
	path: string;
}

/**
 * Find the note a model asked for: exactly, then with .md added, then
 * case-insensitively, then by filename anywhere in the vault. Files the user
 * blocked from reading stay invisible — they are never matched or suggested.
 */
export function findNote(app: App, settings: VaultAssistantSettings, raw: string): NoteLookup {
	const path = toVaultPath(app, raw);
	if (!path) return { file: null, suggestions: [], path };

	const visible = (f: TFile): boolean => isReadable(f.path, settings);

	const direct = app.vault.getAbstractFileByPath(path);
	if (direct instanceof TFile && visible(direct)) return { file: direct, suggestions: [], path };

	const withExt = /\.[a-z0-9]+$/i.test(path) ? null : `${path}.md`;
	if (withExt) {
		const guess = app.vault.getAbstractFileByPath(withExt);
		if (guess instanceof TFile && visible(guess)) return { file: guess, suggestions: [], path };
	}

	const wanted = path.toLowerCase();
	const wantedWithExt = withExt?.toLowerCase();
	const base = (wanted.split('/').pop() ?? '').replace(/\.md$/, '');

	const files = app.vault.getFiles().filter(visible);
	const insensitive = files.find(
		(f) => f.path.toLowerCase() === wanted || f.path.toLowerCase() === wantedWithExt,
	);
	if (insensitive) return { file: insensitive, suggestions: [], path };

	// Obsidian's own resolution, before ours: this is what decides where
	// [[Ideas]] points, so it accepts a bare filename with no folder path and
	// follows frontmatter aliases — both of which the basename scan below
	// misses. Asked from no particular note ('') it searches the whole vault.
	const byLinkpath = app.metadataCache.getFirstLinkpathDest(path.replace(/\.md$/i, ''), '');
	if (byLinkpath && visible(byLinkpath)) return { file: byLinkpath, suggestions: [], path };

	// The same filename somewhere else in the vault is the usual near-miss.
	const sameName = files.filter((f) => f.basename.toLowerCase() === base);
	if (sameName.length === 1 && sameName[0]) return { file: sameName[0], suggestions: [], path };

	const suggestions = (
		sameName.length ? sameName : files.filter((f) => f.basename.toLowerCase().includes(base))
	)
		.slice(0, MAX_SUGGESTIONS)
		.map((f) => f.path);

	return { file: null, suggestions, path };
}

/** Find the folder a model asked for, accepting the same sloppiness. */
export function findFolder(app: App, raw: string): TFolder | null {
	const path = toVaultPath(app, raw);
	if (!path) return app.vault.getRoot();

	const direct = app.vault.getAbstractFileByPath(path);
	if (direct instanceof TFolder) return direct;

	const wanted = path.toLowerCase();
	const match = app.vault
		.getAllLoadedFiles()
		.find((f): f is TFolder => f instanceof TFolder && f.path.toLowerCase() === wanted);
	return match ?? null;
}

/** The "I couldn't find it" message, with the best next step attached. */
export function notFoundMessage(lookup: NoteLookup): string {
	const suggestions = lookup.suggestions.length
		? ` Closest matches in the vault: ${lookup.suggestions.join(', ')}.`
		: ' Use search or list_files to find its real path.';
	return (
		`Error: no file "${lookup.path}" in the vault.${suggestions}` +
		' Paths are relative to the vault root, e.g. "Notes/Ideas.md".'
	);
}
