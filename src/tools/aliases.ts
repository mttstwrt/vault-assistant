/**
 * Steering models toward the vault tools.
 *
 * Models trained as coding agents reach for a shell and a filesystem first —
 * `ls`, `cat`, `grep`, `read_file` with an absolute path — and burn rounds
 * discovering that none of them exist. There is no shell here, and the vault is
 * reached only through the tools in this plugin.
 *
 * So: a read-only call under a familiar name is run as its vault equivalent,
 * and anything that could change a file is answered with a correction naming
 * the tool to use instead. Guessing is only ever done where the worst case is
 * an unhelpful listing, never where it could overwrite a note.
 */

/** Familiar names for our read-only tools. Safe to run as the real thing. */
const READ_ALIASES: Record<string, string> = {
	ls: 'list_files',
	dir: 'list_files',
	list_dir: 'list_files',
	list_directory: 'list_files',
	list_files_in_directory: 'list_files',
	read_directory: 'list_files',
	glob: 'list_files',
	glob_file_search: 'list_files',

	cat: 'read_file',
	open_file: 'read_file',
	read: 'read_file',
	read_text_file: 'read_file',
	view_file: 'read_file',
	get_file: 'read_file',
	get_file_contents: 'read_file',
	fetch_file: 'read_file',

	grep: 'search',
	rg: 'search',
	ripgrep: 'search',
	grep_search: 'search',
	search_files: 'search',
	find_in_files: 'search',
	text_search: 'search',
	full_text_search: 'search',
};

/** Names that would change something. Corrected, never guessed at. */
const WRITE_ALIASES: Record<string, string> = {
	write: 'write_file',
	create_file: 'write_file',
	new_file: 'write_file',
	save_file: 'write_file',
	put_file: 'write_file',
	edit: 'write_file',
	edit_file: 'write_file',
	replace_in_file: 'write_file',
	str_replace: 'write_file',
	str_replace_editor: 'write_file',
	apply_patch: 'write_file',
	apply_diff: 'write_file',
	patch_file: 'write_file',
	append: 'append_file',
	insert: 'append_file',
	add_to_file: 'append_file',
	create_note: 'update_wiki',
	create_page: 'update_wiki',
};

/** Shell-shaped names: there is nothing to run them with. */
const SHELL_NAMES = new Set([
	'bash',
	'sh',
	'shell',
	'zsh',
	'fish',
	'powershell',
	'cmd',
	'terminal',
	'console',
	'exec',
	'execute',
	'execute_command',
	'run',
	'run_command',
	'run_shell_command',
	'run_terminal_cmd',
	'command',
	'system',
	'subprocess',
	'python',
	'node',
	'code_interpreter',
]);

/** File operations this plugin deliberately does not offer. */
const UNSUPPORTED = new Set([
	'delete_file',
	'delete',
	'rm',
	'remove_file',
	'unlink',
	'move_file',
	'move',
	'mv',
	'rename_file',
	'rename',
	'copy_file',
	'cp',
	'mkdir',
	'create_directory',
	'create_folder',
]);

/** Argument names other harnesses use for the ones our tools take. */
const ARG_ALIASES: Record<string, string> = {
	file_path: 'path',
	filepath: 'path',
	file: 'path',
	filename: 'path',
	file_name: 'path',
	note: 'path',
	note_path: 'path',
	dir: 'path',
	dir_path: 'path',
	directory: 'path',
	folder: 'path',
	folder_path: 'path',

	text: 'content',
	contents: 'content',
	body: 'content',
	data: 'content',
	new_content: 'content',
	new_text: 'content',
	new_str: 'content',

	q: 'query',
	search: 'query',
	search_query: 'query',
	pattern: 'query',
	keyword: 'query',
	keywords: 'query',
	term: 'query',

	name: 'title',
	page: 'title',
	page_title: 'title',

	max_results: 'limit',
	top_k: 'limit',
	k: 'limit',
	count: 'limit',
	n: 'limit',
};

/** Fold the many spellings of a tool name onto one: `readFile` → `read_file`. */
export function canonicalName(name: string): string {
	return name
		.trim()
		.replace(/^(?:functions?|tools?|default_api|vault)[.:]/i, '')
		.replace(/([a-z\d])([A-Z])/g, '$1_$2')
		.replace(/[\s.-]+/g, '_')
		.toLowerCase();
}

/** Accept another harness's argument names for ours, without clobbering ours. */
export function normalizeArgs(args: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = { ...args };
	for (const [from, to] of Object.entries(ARG_ALIASES)) {
		if (out[to] === undefined && out[from] !== undefined) out[to] = out[from];
	}
	return out;
}

export interface ToolRedirect {
	/** The vault tool to run instead. */
	run?: string;
	/** What to tell the model when nothing can safely be run. */
	message?: string;
}

/** The tools that read the vault, named for the correction messages. */
const READ_TOOLS = 'list_files, read_file, search';

/**
 * Work out what a model meant by a tool this plugin doesn't have.
 * `available` is the set of tools actually offered for this request.
 */
export function redirectTool(name: string, available: Set<string>): ToolRedirect {
	const canonical = canonicalName(name);

	// A spelling variant of a real tool ("Read_File", "readFile").
	if (available.has(canonical)) return { run: canonical };

	const read = READ_ALIASES[canonical];
	if (read && available.has(read)) return { run: read };

	const write = WRITE_ALIASES[canonical];
	if (write) {
		return {
			message:
				`There is no "${name}" tool. To change a note in this vault use ${write}` +
				(write === 'write_file'
					? ' (arguments: path, content — it replaces the whole file, so read_file first and send the full new text)'
					: write === 'append_file'
						? ' (arguments: path, content)'
						: ' (arguments: title, content)') +
				`. Paths are relative to the vault root, e.g. "Notes/Ideas.md".`,
		};
	}

	if (SHELL_NAMES.has(canonical)) {
		return {
			message:
				`There is no shell here and no "${name}" tool: this is an Obsidian vault, not a filesystem you can run commands against. ` +
				`Use the vault tools instead — ${READ_TOOLS} to look around, write_file/append_file to change a note. Paths are relative to the vault root.`,
		};
	}

	if (UNSUPPORTED.has(canonical)) {
		return {
			message:
				`There is no "${name}" tool: this plugin cannot delete, move, copy or rename files. ` +
				`Tell the user what you would like changed and let them do it in Obsidian. To add or edit content, use write_file or append_file.`,
		};
	}

	return {
		message:
			`There is no "${name}" tool. Available tools: ${[...available].sort().join(', ')}. ` +
			`Everything in this vault is reached through them — there is no shell and no filesystem access, and paths are relative to the vault root, e.g. "Notes/Ideas.md".`,
	};
}
