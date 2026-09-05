/**
 * Structural file operations, done through Obsidian rather than around it.
 *
 * The one that matters is the move: FileManager.renameFile is the same code
 * path as dragging a note in the file explorer, so links to the moved note are
 * rewritten exactly as they are when the user does it by hand. Vault.rename is
 * the trap — it moves the file and leaves every link pointing at nothing.
 */
import { App, TAbstractFile, TFile, TFolder, normalizePath } from 'obsidian';
import { VaultAssistantSettings } from '../settings';
import { isReadable } from '../permissions';
import { buildBacklinks } from './graph';
import { toVaultPath } from './paths';

/** How long to wait for the metadata cache to settle after a move. */
const RESOLVE_TIMEOUT_MS = 3000;

/**
 * Create a folder and any missing parents.
 *
 * Level by level rather than in one call because Vault.createFolder throws when
 * the folder exists and says nothing about creating parents, so this is the
 * correct use of it rather than a workaround for it.
 */
export async function ensureFolder(app: App, folder: string): Promise<void> {
	const parts = normalizePath(folder).split('/').filter(Boolean);
	let cur = '';
	for (const p of parts) {
		cur = cur ? `${cur}/${p}` : p;
		if (!app.vault.getAbstractFileByPath(cur)) {
			try {
				await app.vault.createFolder(cur);
			} catch {
				// Another writer got there first; that is the outcome we wanted.
			}
		}
	}
}

/**
 * Where a move should land. Both readings of `to` are common enough that
 * guessing silently would be wrong, so the rule is stated and the result line
 * always reports where the file actually went: an existing folder means "move
 * into it, keep the name"; anything else is the new full path.
 */
export function resolveDestination(app: App, source: TAbstractFile, to: string): string {
	// The trailing slash has to be read before normalizing, which strips it —
	// it is the way to say "a folder" about one that does not exist yet, and
	// the only thing distinguishing that from a new filename. Everything else
	// goes through toVaultPath, so a destination arrives here as sloppily as a
	// source may: an absolute path, a Windows one, a leading "./".
	const wantsFolder = to.trim().endsWith('/');
	const raw = toVaultPath(app, to.replace(/\/+$/, ''));
	const existing = app.vault.getAbstractFileByPath(raw);
	const intoFolder = existing instanceof TFolder || wantsFolder;
	if (intoFolder) return normalizePath(`${raw}/${source.name}`);

	// A destination with no extension, for a file that has one, means a folder
	// path the user has not created yet or a filename missing its suffix; the
	// suffix is the safer guess, since the folder case is covered above.
	if (source instanceof TFile && source.extension && !/\.[a-z0-9]+$/i.test(raw)) {
		return `${raw}.${source.extension}`;
	}
	return raw;
}

/** Every file inside `folder`, at any depth. */
function filesUnder(folder: TFolder): TFile[] {
	const out: TFile[] = [];
	const walk = (f: TFolder): void => {
		for (const c of f.children) {
			if (c instanceof TFolder) walk(c);
			else if (c instanceof TFile) out.push(c);
		}
	};
	walk(folder);
	return out;
}

/**
 * Refuse to move a folder holding anything the agent may not read.
 *
 * Without this, the read blocklist is one drag away from useless: the agent
 * cannot read Private/, but it could move Private/ to a folder it can read and
 * read it there. Single files need no equivalent check — findNote never matches
 * or suggests a blocked file, so one can never reach this code.
 */
export function blockedChild(source: TAbstractFile, settings: VaultAssistantSettings): string | null {
	if (!(source instanceof TFolder)) return null;
	const hidden = filesUnder(source).filter((f) => !isReadable(f.path, settings));
	return hidden.length
		? `Error: "${source.path}" contains ${hidden.length} file(s) in folders you are blocked from reading, so it cannot be moved. Ask the user to move it in Obsidian.`
		: null;
}

/** Wait for the metadata cache to finish re-resolving links, or give up. */
function settled(app: App): Promise<boolean> {
	return new Promise((resolve) => {
		const ref = app.metadataCache.on('resolved', () => {
			app.metadataCache.offref(ref);
			window.clearTimeout(timer);
			resolve(true);
		});
		const timer = window.setTimeout(() => {
			app.metadataCache.offref(ref);
			resolve(false);
		}, RESOLVE_TIMEOUT_MS);
	});
}

/**
 * Move or rename through Obsidian, then report what actually happened to the
 * links rather than what was supposed to happen.
 *
 * Whether links follow depends on the vault's "Automatically update internal
 * links" setting, so the honest answer is not a prediction: it is a backlink
 * count taken before the move and again after the cache settles.
 */
export async function moveThroughObsidian(
	app: App,
	source: TAbstractFile,
	destination: string,
): Promise<string> {
	const from = source.path;
	const linkers = source instanceof TFile ? (buildBacklinks(app)[from] ?? []) : [];

	await app.fileManager.renameFile(source, destination);

	const kind = source instanceof TFolder ? 'folder' : 'file';
	const moved = `Moved ${kind} ${from} → ${destination}.`;
	if (!linkers.length) return `${moved} Nothing linked to it.`;

	const confirmed = await settled(app);
	if (!confirmed) {
		return `${moved} ${linkers.length} note(s) linked to it; Obsidian had not finished re-resolving links in time to confirm they followed. Check with the links tool.`;
	}

	const now = new Set(buildBacklinks(app)[destination] ?? []);
	const stale = linkers.filter((p) => !now.has(p));
	if (!stale.length) {
		return `${moved} ${linkers.length} note(s) linked to it, and all of them now point at the new path.`;
	}
	return (
		`${moved} ${linkers.length} note(s) linked to it, but ${stale.length} still point at the old path — ` +
		`Obsidian's "Automatically update internal links" is off in this vault, so nothing was rewritten. ` +
		`Those links are now broken: ${stale.slice(0, 10).join(', ')}. ` +
		`Fix them, or tell the user to turn that setting on before moving anything else.`
	);
}
