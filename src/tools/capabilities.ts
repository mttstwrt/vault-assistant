/**
 * What the agent can actually do, generated rather than written down.
 *
 * A hand-written capability blurb is a lie with a delay on it, so everything
 * here is derived at call time from the same sources the behaviour comes from:
 * the tool set this request was really given, the permission helpers, and the
 * vault's own Obsidian settings. The question this exists to answer accurately
 * is "if you move a note, do the links follow?" — which depends on a setting in
 * the user's vault, not on anything the model could reason its way to.
 */
import { App, Platform, normalizePath } from 'obsidian';
import { VaultAssistantSettings } from '../settings';
import { displayScopes, writeScopes } from '../permissions';

/** One line of "what this tool really does", for the ones that surprise people. */
const NOTES: Record<string, string> = {
	read_file: 'the whole note. Prefer outline + read_section on anything long.',
	read_section:
		'one heading and everything under it, subheadings included — resolved the way Obsidian resolves [[note#heading]].',
	write_file: 'replaces the ENTIRE file. Anything you do not send is gone.',
	write_section: 'changes one heading section and leaves the rest of the note byte-for-byte.',
	append_file: 'adds to the end of a note, creating it if missing.',
	move_file:
		"moves or renames through Obsidian itself, so links follow (see 'How Obsidian behaves' below). Works on folders too.",
	create_folder: 'makes a folder and any missing parents. Never create a placeholder note to make a folder.',
	search: 'grep over note text: regular expressions, line numbers, several hits per file.',
	semantic_search: 'meaning-based recall over an embedding index, for when you do not know the wording.',
	tags: "reads Obsidian's tag index; it does not read note contents, so it is cheap.",
	links: 'outgoing links, backlinks and broken links for one note, without loading any of them.',
	open_files: 'what the user has open right now, and which note is focused.',
	remember: 'writes to your operating memory, which is injected at the start of every future conversation.',
	update_wiki: 'creates or extends a wiki page. Link every new page in, or it is an orphan.',
};

/** Tools grouped by what they are for; twenty in one flat list reads as noise. */
const GROUPS: [string, string[]][] = [
	['Look around', ['list_files', 'open_files', 'outline', 'links', 'tags']],
	['Read', ['read_file', 'read_section', 'wiki_home', 'wiki_page']],
	['Find', ['search', 'semantic_search', 'list_wiki']],
	['Change a note', ['write_section', 'append_file', 'write_file', 'update_wiki', 'remember']],
	['Rearrange the vault', ['move_file', 'create_folder']],
	['Introspect', ['capabilities']],
];

/** Why a tool the plugin has is not on offer this turn. */
function disabledReason(name: string, s: VaultAssistantSettings): string | null {
	if (name === 'semantic_search' && !s.useRag) {
		return 'semantic search is off — the user can enable it under Semantic search in settings (it sends note text to an embedding endpoint, so it is opt-in)';
	}
	if (name === 'open_files' && !s.useOpenFiles) {
		return 'seeing what is open is off — the user can enable "See what you have open" in settings';
	}
	if (name === 'remember' && !s.useMemory) {
		return 'operating memory is off — the user can enable "Use operating memory" in settings';
	}
	return null;
}

/**
 * Whether this vault rewrites links when a note moves.
 *
 * The setting is Settings → Files & links → "Automatically update internal
 * links", stored as alwaysUpdateLinks in the vault's own app.json. There is no
 * public API for it (Vault.getConfig is real but undocumented and untyped), so
 * this reads the file through the public adapter instead. Obsidian only writes
 * keys that differ from the default, so an absent key means on.
 *
 * Never cached: it is read rarely, the file is tiny, and a cached answer would
 * be wrong for the rest of the session the moment the user flips the setting.
 */
async function updatesLinksOnMove(app: App): Promise<boolean | null> {
	try {
		const raw = await app.vault.adapter.read(normalizePath(`${app.vault.configDir}/app.json`));
		const config = JSON.parse(raw) as Record<string, unknown>;
		const value = config.alwaysUpdateLinks;
		return typeof value === 'boolean' ? value : true;
	} catch {
		return null;
	}
}

/** How a move will behave in this vault, in the words the user would need. */
function moveBehaviour(updates: boolean | null): string {
	if (updates === null) {
		return (
			'Whether [[links]] follow a moved note is decided by Obsidian\'s "Automatically update internal links" ' +
			'(Settings → Files & links), and I could not read this vault\'s setting. Do not guess: move_file counts the ' +
			'backlinks before and after and its result says whether they actually followed.'
		);
	}
	if (updates) {
		return (
			'move_file calls Obsidian\'s own rename, the same code path as dragging a note in the file explorer. ' +
			'This vault has "Automatically update internal links" (Settings → Files & links) ON, so [[links]] and ' +
			'markdown links pointing at a moved note are rewritten for you, and links inside the moved note are ' +
			'fixed up too. Plain-text mentions of a path, and paths inside code blocks, are not links and are not ' +
			'touched. move_file re-checks the backlinks afterwards and tells you if any failed to follow.'
		);
	}
	return (
		'This vault has "Automatically update internal links" (Settings → Files & links) OFF, so moving a note ' +
		'BREAKS every [[link]] pointing at it — Obsidian will not rewrite them. move_file still works and still ' +
		'reports which notes were left pointing at the old path, but say this to the user before moving anything ' +
		'they care about: they may want to turn that setting on first.'
	);
}

/**
 * The `capabilities` tool's output. `offered` is the tool set this request was
 * actually given, so a workflow step's allowlist and every settings toggle are
 * reflected without this module knowing about either.
 */
export async function describeCapabilities(
	app: App,
	settings: VaultAssistantSettings,
	offered: Set<string>,
): Promise<string> {
	const out: string[] = ['What you can do in this vault right now.', ''];

	out.push('TOOLS YOU HAVE');
	const grouped = new Set<string>();
	for (const [label, names] of GROUPS) {
		const have = names.filter((n) => offered.has(n));
		for (const n of names) grouped.add(n);
		if (!have.length) continue;
		out.push(`${label}:`);
		for (const n of have) out.push(NOTES[n] ? `  ${n} — ${NOTES[n]}` : `  ${n}`);
	}
	const mcp = [...offered].filter((n) => n.startsWith('mcp__')).sort();
	const other = [...offered].filter((n) => !grouped.has(n) && !n.startsWith('mcp__')).sort();
	if (other.length) out.push(`Also available: ${other.join(', ')}.`);
	if (mcp.length) {
		out.push(
			`From connected MCP servers: ${mcp.join(', ')}. These reach outside the vault; an untrusted server's call pauses for the user to approve.`,
		);
	}

	const missing = ['semantic_search', 'open_files', 'remember']
		.filter((n) => !offered.has(n))
		.map((n) => [n, disabledReason(n, settings)] as const)
		.filter((pair): pair is readonly [string, string] => pair[1] !== null);
	if (missing.length) {
		out.push('', 'TOOLS YOU DO NOT HAVE THIS SESSION');
		for (const [n, why] of missing) out.push(`  ${n} — ${why}`);
	}

	out.push(
		'',
		'WHAT YOU MAY TOUCH',
		settings.readBlockPaths.length
			? `Read: the whole vault except ${settings.readBlockPaths.length === 1 ? 'one folder' : `${settings.readBlockPaths.length} folders`} the user has blocked. Blocked notes are invisible to you — they never appear in a listing, a search, or a suggestion, so you cannot tell the user what is in one.`
			: 'Read: the whole vault.',
		`Write freely: ${displayScopes(writeScopes(settings))}.`,
		'Writing, moving or creating a folder anywhere else pauses and asks the user to approve it, showing them the change first. During an autonomous workflow run there is nobody to ask, so those are refused instead — stay inside the folders above when running unattended.',
	);

	out.push(
		'',
		'HOW OBSIDIAN BEHAVES',
		moveBehaviour(await updatesLinksOnMove(app)),
		'[[Links]] resolve by note NAME, not by path, so a link keeps working after the note moves and you can write [[Ideas]] without knowing which folder it is in. A link to a note that does not exist is not an error — Obsidian shows it as an unresolved link, and the links tool lists it as broken.',
		'Your writes go to the file on disk; if the user has that note open, Obsidian reloads it under them. You cannot type into their editor, move their cursor, or open a note for them.',
	);

	out.push(
		'',
		'WHAT YOU CANNOT DO',
		'  Delete or copy a file — ask the user to do it in Obsidian.',
		'  Run a shell command, a script, or any program. There is no shell here.',
		'  Reach the filesystem outside this vault, or the network. Paths are vault-relative always.',
		'  Run Obsidian commands, change its settings, or install plugins.',
		`  ${Platform.isDesktopApp ? 'This is desktop Obsidian, so MCP servers over stdio can work.' : 'This is mobile Obsidian: MCP servers that need a local process cannot run here, only in-process and HTTP ones.'}`,
	);

	out.push(
		'',
		'If the user asks whether you can do something not covered here, say you are not sure rather than guessing.',
	);
	return out.join('\n');
}
