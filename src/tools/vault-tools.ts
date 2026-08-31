import { App, TFile, TFolder, normalizePath } from 'obsidian';
import { VaultAssistantSettings } from '../settings';
import { ApprovalRequest, ApprovalResult, FileChange, ToolSpec } from '../types';
import { displayScopes, isReadable, isWritable, parentFolder, writeScopes } from '../permissions';
import { McpManager } from '../mcp/manager';
import { RagIndexer } from '../rag/indexer';
import { buildWikiIndex, describeLinks, wikiHomePath } from './graph';
import { describeOpenFiles } from './workspace';
import { normalizeArgs, redirectTool } from './aliases';
import { findFolder, findNote, notFoundMessage, toVaultPath } from './paths';
import { SearchOptions, renderHits, runSearch } from './search';
import {
	SectionRange,
	describeOutline,
	isBlockRef,
	noSuchSection,
	sectionRange,
	spliceSection,
	splitSubpath,
} from './sections';
import { describeTags } from './tags';
import { describeCapabilities } from './capabilities';
import {
	blockedChild,
	ensureFolder,
	moveThroughObsidian,
	resolveDestination,
} from './files';

/** Everything a tool invocation needs: the app, settings, and the approval hooks. */
export interface ToolContext {
	app: App;
	settings: VaultAssistantSettings;
	/** Persist settings after an "always allow" grant widens the write allowlist. */
	saveSettings: () => Promise<void>;
	/** Write paths approved for the rest of this conversation only. */
	sessionWrites: Set<string>;
	/** MCP tool names approved for the rest of this conversation only. */
	sessionMcp: Set<string>;
	/** Connected MCP servers and their tools. */
	mcp: McpManager;
	/** The semantic index behind the semantic_search tool. */
	rag: RagIndexer;
	/** Ask the user to approve a write outside the allowlist, or an MCP call. */
	requestApproval: (req: ApprovalRequest) => Promise<ApprovalResult>;
	/** Report a write, so the panel can show it as a diff. UI only. */
	onFileChange?: (change: FileChange) => void;
}

export const TOOL_SPECS: ToolSpec[] = [
	{
		name: 'capabilities',
		description:
			"What you can actually do in this vault: the tools you have this turn and what each really does, which folders you may read and write, how Obsidian itself will behave (whether links follow a moved note, above all), and what is genuinely impossible here. Read from live settings, not from memory. Call it BEFORE telling the user you can or cannot do something, and before any operation whose consequences you are unsure of.",
		parameters: { type: 'object', properties: {} },
	},
	{
		name: 'list_files',
		description:
			'List the files and folders inside a vault folder. Use an empty or omitted path for the vault root. Raise depth to see a whole subtree in one call instead of walking it level by level.',
		parameters: {
			type: 'object',
			properties: {
				path: {
					type: 'string',
					description: 'Folder path relative to the vault root. Empty/omitted = root.',
				},
				depth: {
					type: 'number',
					description: 'How many levels to descend. 1 (default) lists the folder itself; max 4.',
				},
			},
		},
	},
	{
		name: 'read_file',
		description: 'Read the full text contents of a note or file in the vault.',
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'File path relative to the vault root.' },
			},
			required: ['path'],
		},
	},
	{
		name: 'outline',
		description:
			"A note's shape without its contents: its heading tree with line ranges, its frontmatter keys, and how many links and tags it has. Use it before read_file on anything long — then pull just the part you need with read_section.",
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'File path relative to the vault root.' },
			},
			required: ['path'],
		},
	},
	{
		name: 'read_section',
		description:
			'Read one section of a note — a heading and everything under it, including its subheadings — instead of the whole file. Also reads a block reference ("#^blockid"). Resolved exactly the way Obsidian resolves [[note#heading]]. Prefer this to read_file whenever you know which part you want.',
		parameters: {
			type: 'object',
			properties: {
				path: {
					type: 'string',
					description: 'File path, optionally with the heading appended: "Notes/Ideas.md#Chunking".',
				},
				heading: {
					type: 'string',
					description: 'The heading to read, if not already appended to path. "^blockid" for a block.',
				},
			},
			required: ['path'],
		},
	},
	{
		name: 'write_section',
		description:
			'Replace or extend the body of ONE heading section, leaving the rest of the note untouched. Use this rather than write_file whenever you are changing part of a note — write_file replaces the whole file and will lose everything you did not send. The heading line itself is never changed; "append" adds to the end of that section, before the next heading.',
		parameters: {
			type: 'object',
			properties: {
				path: {
					type: 'string',
					description: 'File path, optionally with the heading appended: "Notes/Ideas.md#Chunking".',
				},
				heading: { type: 'string', description: 'The heading to write under, if not appended to path.' },
				content: { type: 'string', description: 'The new body for that section.' },
				mode: {
					type: 'string',
					enum: ['replace', 'append'],
					description: "'replace' (default) swaps the section body; 'append' adds to the end of it.",
				},
			},
			required: ['path', 'content'],
		},
	},
	{
		name: 'tags',
		description:
			"With no argument: every tag in the vault and how many notes carry it. With a tag: the notes carrying it, children included (#project covers #project/active). Reads Obsidian's metadata, not note contents, so it is cheap — use it instead of searching for a '#word' string.",
		parameters: {
			type: 'object',
			properties: {
				tag: { type: 'string', description: 'Tag to look up, with or without the leading #. Omit to list all tags.' },
				limit: { type: 'number', description: 'Max notes to name for one tag (default 40).' },
			},
		},
	},
	{
		name: 'search',
		description:
			'Text search across markdown notes, grep-style: every hit is reported as "path:line: text", several per file where several exist. Supports regular expressions and the usual grep options. This is the tool a grep or ripgrep call means here. For a concept rather than a string use semantic_search; to read what a hit belongs to use read_section.',
		parameters: {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'Text to find, or a regular expression when regex is true.' },
				regex: {
					type: 'boolean',
					description: 'Treat query as a JavaScript regular expression (default false).',
				},
				path: {
					type: 'string',
					description: 'Only search inside this folder. Omit to search the whole vault.',
				},
				case_sensitive: { type: 'boolean', description: 'Default false (grep -i is the default here).' },
				whole_word: { type: 'boolean', description: 'Match whole words only (grep -w).' },
				invert: { type: 'boolean', description: 'Report lines that do NOT match (grep -v).' },
				context: { type: 'number', description: 'Lines of context either side of a hit, 0-3 (grep -C).' },
				multiline: {
					type: 'boolean',
					description: 'Match across line breaks rather than line by line. Slower; use only when the pattern needs it.',
				},
				files_only: { type: 'boolean', description: 'List matching file paths only (rg -l).' },
				limit: { type: 'number', description: 'Max hits overall (default 20, max 100).' },
				max_per_file: { type: 'number', description: 'Max hits per file (default 3).' },
			},
			required: ['query'],
		},
	},
	{
		name: 'write_file',
		description:
			'Create or overwrite a file. Only works inside writable folders. Use for new notes the user asked you to create.',
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'File path relative to the vault root.' },
				content: { type: 'string', description: 'Full file contents.' },
			},
			required: ['path', 'content'],
		},
	},
	{
		name: 'append_file',
		description:
			'Append text to the end of a file, creating it if missing. Only works inside writable folders.',
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'File path relative to the vault root.' },
				content: { type: 'string', description: 'Text to append.' },
			},
			required: ['path', 'content'],
		},
	},
	{
		name: 'move_file',
		description:
			"Move or rename a note or a folder. This goes through Obsidian itself, the same as dragging it in the file explorer, so [[links]] pointing at it are updated the way Obsidian updates them — and the result tells you whether they actually followed. Use it instead of writing a copy and abandoning the original. Needs write permission at both ends.",
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'The note or folder to move, relative to the vault root.' },
				to: {
					type: 'string',
					description:
						'Where it goes. An existing folder means "move into it, keep the name"; anything else is the new full path.',
				},
			},
			required: ['path', 'to'],
		},
	},
	{
		name: 'create_folder',
		description:
			'Create a folder, and any parent folders missing above it. Use this when a folder needs to exist — never create a placeholder note to bring one into being.',
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Folder path relative to the vault root.' },
			},
			required: ['path'],
		},
	},
	{
		name: 'remember',
		description:
			"Save a durable fact to your operating memory — something you should know at the START of every future conversation: where data lives, the formats/conventions the user uses, and corrections (e.g. \"habits are tracked in Trackers/2026.base now, not the old Habits/ folder\"). This memory file is injected into your context automatically each session, so keep it short and high-signal. Prefer mode 'replace' with a cleaned-up full version to dedupe and fix stale entries; use 'append' to quickly add one new fact. This is for HOW the vault works — use update_wiki for WHAT is in it.",
		parameters: {
			type: 'object',
			properties: {
				content: {
					type: 'string',
					description:
						"The memory text: a single fact (for 'append') or the full curated memory file (for 'replace').",
				},
				mode: {
					type: 'string',
					enum: ['append', 'replace'],
					description:
						"'append' (default) adds to the end of the memory file; 'replace' overwrites it entirely with a curated version.",
				},
			},
			required: ['content'],
		},
	},
	{
		name: 'wiki_home',
		description:
			"Read the wiki's Home page — the curated entry point / table of contents. This is the starting move for recalling curated knowledge: read Home, then follow its [[links]] toward the topic with wiki_page.",
		parameters: { type: 'object', properties: {} },
	},
	{
		name: 'wiki_page',
		description:
			'Read a wiki page by title, together with its neighbours (outgoing links, backlinks, broken links) in one call. Use it to hop through the wiki from Home toward a topic.',
		parameters: {
			type: 'object',
			properties: {
				title: { type: 'string', description: 'Wiki page title (the filename without .md).' },
			},
			required: ['title'],
		},
	},
	{
		name: 'semantic_search',
		description:
			'Embedding-based search over the indexed vault: finds notes about a concept even when the wording differs. Use it for fuzzy recall ("somewhere I wrote about…"), then read the note or wiki page it surfaces. For exact strings or filenames use search; for curated topics start at wiki_home.',
		parameters: {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'What to look for, phrased naturally.' },
				limit: { type: 'number', description: 'Max results (default from settings, max 20).' },
			},
			required: ['query'],
		},
	},
	{
		name: 'list_wiki',
		description:
			'The wiki sitemap: every wiki note, how it links to other notes and the rest of the vault, and a maintenance worklist (orphan pages, broken links). Use it before creating pages and for curation — for recall, start at wiki_home instead.',
		parameters: { type: 'object', properties: {} },
	},
	{
		name: 'open_files',
		description:
			'See what the user currently has open in Obsidian: every open tab and which note is focused. Use it whenever the request is about the note in front of them rather than a named file — "what am I looking at", "summarise this", "add a task to this note" — then read_file the focused path. Notes in blocked folders are not listed.',
		parameters: { type: 'object', properties: {} },
	},
	{
		name: 'links',
		description:
			'Show the outgoing links and backlinks for a note, plus any broken links. Use it to understand how a note connects to others (including past conversations) before writing or linking.',
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'File path relative to the vault root.' },
			},
			required: ['path'],
		},
	},
	{
		name: 'update_wiki',
		description:
			'Create or update a wiki note in the wiki folder. Use [[wikilinks]] to connect it to related wiki notes, the user\'s existing notes, and past conversations. Call list_wiki first to see what already exists.',
		parameters: {
			type: 'object',
			properties: {
				title: { type: 'string', description: 'Wiki note title (becomes the filename).' },
				content: { type: 'string', description: 'Markdown contents of the wiki note.' },
				mode: {
					type: 'string',
					enum: ['replace', 'append'],
					description:
						"'replace' (default) overwrites the note; 'append' adds to the end of an existing note.",
				},
			},
			required: ['title', 'content'],
		},
	},
];

/** The built-in tool specs to offer the model, given the current settings. */
export function activeToolSpecs(settings: VaultAssistantSettings): ToolSpec[] {
	const off = new Set<string>();
	if (!settings.useRag) off.add('semantic_search');
	if (!settings.useOpenFiles) off.add('open_files');
	return off.size ? TOOL_SPECS.filter((t) => !off.has(t.name)) : TOOL_SPECS;
}

/** How deep `list_files` will descend, and how many entries it will print. */
const MAX_LIST_DEPTH = 4;
const MAX_LIST_ENTRIES = 500;

/**
 * A folder's contents, up to `depth` levels down. Paths stay vault-relative on
 * every line even though indentation already shows the shape: a model copies a
 * line straight into read_file, and a bare indented name would not resolve.
 */
function listFolder(folder: TFolder, settings: VaultAssistantSettings, depth: number): string[] {
	const out: string[] = [];
	const walk = (f: TFolder, level: number, indent: string): void => {
		const children = [...f.children].sort((a, b) => a.path.localeCompare(b.path));
		for (const c of children) {
			if (out.length >= MAX_LIST_ENTRIES) return;
			if (c instanceof TFolder) {
				out.push(`${indent}${c.path}/`);
				if (level < depth) walk(c, level + 1, `${indent}  `);
			} else if (isReadable(c.path, settings)) {
				out.push(`${indent}${c.path}`);
			}
		}
	};
	walk(folder, 1, '');
	if (out.length >= MAX_LIST_ENTRIES) out.push(`…(stopped at ${MAX_LIST_ENTRIES} entries)`);
	return out;
}

/** What a file holds right now, or '' when it doesn't exist yet. */
async function currentContent(app: App, path: string): Promise<string> {
	const f = app.vault.getAbstractFileByPath(path);
	return f instanceof TFile ? await app.vault.read(f) : '';
}

/**
 * Decide whether `path` may be written. Returns null to proceed, or an error
 * string to hand back to the model when the user denies. Prompts the user for
 * out-of-scope writes and may widen the allowlist (for this session, or
 * persistently) as a side effect of an "always allow" grant.
 *
 * `after` is the content the tool intends to write, so the approval card can
 * show the diff. It is read for the prompt only — an allowed write never
 * touches the file here.
 */
async function ensureWritable(
	ctx: ToolContext,
	tool: string,
	path: string,
	after: string,
): Promise<string | null> {
	const p = normalizePath(path);
	if (isWritable(p, ctx.settings) || ctx.sessionWrites.has(p)) return null;

	const folder = parentFolder(p);
	const decision = await ctx.requestApproval({
		kind: 'write',
		tool,
		path: p,
		folder,
		preview: { before: await currentContent(ctx.app, p), after },
	});
	switch (decision) {
		case 'once':
			return null;
		case 'session':
			ctx.sessionWrites.add(p);
			return null;
		case 'always-file':
			ctx.settings.writePaths.push(p);
			await ctx.saveSettings();
			return null;
		case 'always-folder':
			ctx.settings.writePaths.push(folder || p);
			await ctx.saveSettings();
			return null;
		case 'deny':
		default:
			return `Error: writing to "${p}" is not permitted. Writable folders: ${displayScopes(writeScopes(ctx.settings))}.`;
	}
}

/** The "you may not" message, naming what the agent may in fact touch. */
function outOfScope(ctx: ToolContext, what: string): string {
	return `Error: ${what} is not permitted. Writable folders: ${displayScopes(writeScopes(ctx.settings))}.`;
}

/**
 * Gate a move. Both ends need write permission, and the user is asked once for
 * the move rather than twice for its halves — approving the removal but not the
 * arrival is not a state anyone wants to be in.
 */
async function ensureMovable(ctx: ToolContext, from: string, to: string): Promise<string | null> {
	const ok = (p: string): boolean =>
		isWritable(p, ctx.settings) || ctx.sessionWrites.has(p);
	if (ok(from) && ok(to)) return null;

	const decision = await ctx.requestApproval({
		kind: 'move',
		tool: 'move_file',
		path: from,
		toPath: to,
		folder: parentFolder(to),
	});
	switch (decision) {
		case 'once':
			return null;
		case 'session':
			ctx.sessionWrites.add(from);
			ctx.sessionWrites.add(to);
			return null;
		case 'always-file':
			ctx.settings.writePaths.push(from, to);
			await ctx.saveSettings();
			return null;
		case 'always-folder':
			ctx.settings.writePaths.push(parentFolder(from) || from, parentFolder(to) || to);
			await ctx.saveSettings();
			return null;
		default:
			return outOfScope(ctx, `moving "${from}" to "${to}"`);
	}
}

/** Gate a folder creation: no contents, but still a directory in someone's vault. */
async function ensureFolderAllowed(ctx: ToolContext, path: string): Promise<string | null> {
	if (isWritable(path, ctx.settings) || ctx.sessionWrites.has(path)) return null;

	const decision = await ctx.requestApproval({
		kind: 'create-folder',
		tool: 'create_folder',
		path,
		folder: parentFolder(path),
	});
	switch (decision) {
		case 'once':
			return null;
		case 'session':
			ctx.sessionWrites.add(path);
			return null;
		case 'always-folder':
			ctx.settings.writePaths.push(parentFolder(path) || path);
			await ctx.saveSettings();
			return null;
		default:
			return outOfScope(ctx, `creating the folder "${path}"`);
	}
}

/**
 * Run an MCP tool, gating untrusted servers behind the approval card. Returns
 * the tool output, or an error string if the user denies.
 */
async function callMcp(ctx: ToolContext, name: string, argsJson: string): Promise<string> {
	const cfg = ctx.mcp.serverFor(name);
	if (!cfg) return `Error: unknown MCP tool "${name}".`;

	if (!ctx.mcp.isTrusted(name) && !ctx.sessionMcp.has(name)) {
		const decision = await ctx.requestApproval({
			kind: 'mcp',
			tool: name,
			serverId: cfg.id,
			serverName: cfg.name,
			args: argsJson,
		});
		switch (decision) {
			case 'once':
				break;
			case 'session':
				ctx.sessionMcp.add(name);
				break;
			case 'always-trust':
				cfg.trusted = true;
				await ctx.saveSettings();
				break;
			default:
				return `Error: calling "${name}" was not permitted by the user.`;
		}
	}
	return ctx.mcp.callTool(name, argsJson);
}

/**
 * Create or overwrite a file, with no permission check, reporting what changed
 * so the panel can show a diff. The model only gets the one-line result.
 */
async function doWrite(ctx: ToolContext, path: string, content: string): Promise<string> {
	const { app } = ctx;
	const p = normalizePath(path);
	const dir = parentFolder(p);
	if (dir) await ensureFolder(app, dir);

	const existing = app.vault.getAbstractFileByPath(p);
	if (existing instanceof TFile) {
		const before = await app.vault.read(existing);
		await app.vault.modify(existing, content);
		ctx.onFileChange?.({ path: p, kind: 'update', before, after: content });
		return `Updated ${p}`;
	}
	await app.vault.create(p, content);
	ctx.onFileChange?.({ path: p, kind: 'create', before: '', after: content });
	return `Created ${p}`;
}

/**
 * Change a file through Vault.process, which re-reads and writes under
 * Obsidian's own lock — so an edit the user makes in the note while the agent
 * is deciding what to write is not silently discarded, which is what a
 * read-then-modify pair does. `compute` returns the new text, or null to leave
 * the file alone; the return value says whether anything was written.
 */
async function processWrite(
	ctx: ToolContext,
	file: TFile,
	compute: (current: string) => string | null,
): Promise<boolean> {
	let before = '';
	let after: string | null = null;
	await ctx.app.vault.process(file, (cur) => {
		before = cur;
		after = compute(cur);
		return after ?? cur;
	});
	if (after === null) return false;
	ctx.onFileChange?.({ path: file.path, kind: 'update', before, after });
	return true;
}

/**
 * Append to a file atomically, creating it when it does not exist yet. The
 * concatenation happens inside process(), so it lands on whatever the note
 * holds at write time rather than on a copy read moments earlier.
 */
async function appendTo(ctx: ToolContext, path: string, addition: string): Promise<string> {
	const existing = ctx.app.vault.getAbstractFileByPath(path);
	if (!(existing instanceof TFile)) return await doWrite(ctx, path, addition);
	await processWrite(ctx, existing, (cur) => `${cur}${addition}`);
	return `Appended to ${path}`;
}

/** Permission-checked create/overwrite. */
async function writeFile(
	ctx: ToolContext,
	tool: string,
	path: string,
	content: string,
): Promise<string> {
	const denied = await ensureWritable(ctx, tool, path, content);
	if (denied) return denied;
	return doWrite(ctx, path, content);
}

/** The heading a caller passed separately, normalised to a "#…" subpath. */
function headingArg(args: Record<string, unknown>): string {
	const raw = str(args.heading).trim();
	if (!raw) return '';
	return raw.startsWith('#') ? raw : `#${raw}`;
}

interface SectionTarget {
	file: TFile;
	text: string;
	range: SectionRange;
}

/**
 * Resolve the (file, section) a read_section/write_section call names, taking
 * the heading either appended to the path or as its own argument — models
 * write both and neither is wrong. Returns an error string to hand back when
 * the note or the heading does not resolve.
 */
async function resolveSection(
	app: App,
	settings: VaultAssistantSettings,
	args: Record<string, unknown>,
): Promise<SectionTarget | string> {
	const { path, subpath } = splitSubpath(str(args.path));
	const found = findNote(app, settings, path);
	if (!found.file) return notFoundMessage(found);
	const file = found.file;
	const wanted = subpath || headingArg(args);
	if (!wanted) {
		return `Error: which section of ${file.path}? Pass a heading, or call outline to see them.`;
	}
	const text = await app.vault.cachedRead(file);
	const range = sectionRange(app, file, wanted, text.length);
	return range ? { file, text, range } : noSuchSection(app, file, wanted);
}

/** Coerce an unknown tool argument to a string safely. */
function str(v: unknown): string {
	return typeof v === 'string' ? v : '';
}

function sanitizeTitle(title: string): string {
	return title
		.replace(/[\\/:*?"<>|#^[\]]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * Run a tool by name and return a string result for the model.
 *
 * `offered` is the set of tool names this request was given, used to redirect
 * a model that reaches for a shell or a filesystem tool instead (see
 * ./aliases). MCP tools dispatch on their own prefix.
 */
export async function executeTool(
	ctx: ToolContext,
	name: string,
	argsJson: string,
	offered?: Set<string>,
): Promise<string> {
	const { app, settings } = ctx;
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(argsJson || '{}') as Record<string, unknown>;
	} catch {
		return 'Error: tool arguments were not valid JSON.';
	}
	const args = normalizeArgs(parsed);

	try {
		switch (name) {
			case 'capabilities':
				return await describeCapabilities(
					app,
					settings,
					offered ?? new Set(activeToolSpecs(settings).map((t) => t.name)),
				);

			case 'list_files': {
				const raw = typeof args.path === 'string' ? args.path : '';
				const folder = findFolder(app, raw);
				if (!folder) return `Error: no folder "${toVaultPath(app, raw)}" in the vault.`;
				const depth = Math.min(Math.max(Math.round(Number(args.depth) || 1), 1), MAX_LIST_DEPTH);
				const lines = listFolder(folder, settings, depth);
				return lines.length ? lines.join('\n') : '(empty folder)';
			}

			case 'read_file': {
				// Blocked files are hidden: findNote never matches or suggests
				// them, so the agent never learns they exist.
				const found = findNote(app, settings, str(args.path));
				if (!found.file) return notFoundMessage(found);
				return await app.vault.cachedRead(found.file);
			}

			case 'search': {
				const query = str(args.query);
				if (!query) return 'Error: a query is required.';
				const opts: SearchOptions = {
					query,
					regex: args.regex === true,
					caseSensitive: args.case_sensitive === true,
					wholeWord: args.whole_word === true,
					invert: args.invert === true,
					multiline: args.multiline === true,
					filesOnly: args.files_only === true,
					scope: args.path ? toVaultPath(app, str(args.path)) : '',
					limit: Math.min(Math.max(Number(args.limit) || 20, 1), 100),
					maxPerFile: Math.min(Math.max(Number(args.max_per_file) || 3, 1), 20),
					context: Math.min(Math.max(Math.round(Number(args.context) || 0), 0), 3),
				};
				const hits = await runSearch(app, settings, opts);
				return typeof hits === 'string' ? hits : renderHits(hits, opts);
			}

			case 'outline': {
				const found = findNote(app, settings, splitSubpath(str(args.path)).path);
				if (!found.file) return notFoundMessage(found);
				return describeOutline(app, found.file, await app.vault.cachedRead(found.file));
			}

			case 'read_section': {
				const target = await resolveSection(app, settings, args);
				if (typeof target === 'string') return target;
				const { file, text, range } = target;
				return `${file.path} › ${range.label}\n\n${text.slice(range.start, range.end).trim()}`;
			}

			case 'write_section': {
				const target = await resolveSection(app, settings, args);
				if (typeof target === 'string') return target;
				const { file, text, range } = target;
				if (isBlockRef(range.label.slice(file.basename.length))) {
					return `Error: write_section edits heading sections, not block references. To change a block, edit the section it sits in, or use write_file.`;
				}
				const mode = str(args.mode) === 'append' ? 'append' : 'replace';
				const after = spliceSection(text, range, str(args.content), mode);
				const denied = await ensureWritable(ctx, 'write_section', file.path, after);
				if (denied) return denied;
				// The offsets came from the metadata cache, so they only describe
				// the text they were resolved against. process() runs under
				// Obsidian's own lock: if the note moved underneath us, splicing
				// at stale offsets would corrupt it, so the write is abandoned
				// and the model is told to look again. Refusing beats guessing.
				const applied = await processWrite(ctx, file, (cur) =>
					cur === text ? after : null,
				);
				if (!applied) {
					return `Error: ${file.path} changed while this edit was being prepared — nothing was written. Read the section again and retry.`;
				}
				return `Updated ${file.path} › ${range.label}`;
			}

			case 'tags':
				return describeTags(
					app,
					settings,
					str(args.tag),
					Math.min(Math.max(Number(args.limit) || 40, 1), 200),
				);

			case 'write_file':
				return await writeFile(
					ctx,
					'write_file',
					toVaultPath(app, str(args.path)),
					str(args.content),
				);

			case 'append_file': {
				const p = toVaultPath(app, str(args.path));
				const existing = app.vault.getAbstractFileByPath(p);
				const cur = existing instanceof TFile ? await app.vault.cachedRead(existing) : null;
				// The preview is what the approval card shows; the write itself
				// re-reads inside process(), so it appends to whatever the note
				// holds by then rather than to this copy.
				const denied = await ensureWritable(ctx, 'append_file', p, (cur ?? '') + str(args.content));
				if (denied) return denied;
				return await appendTo(ctx, p, str(args.content));
			}

			case 'move_file': {
				const found = findNote(app, settings, str(args.path));
				// A folder is not a note, so findNote misses one; try that next.
				const source =
					found.file ?? findFolder(app, str(args.path)) ?? null;
				if (!source) return notFoundMessage(found);

				const hidden = blockedChild(source, settings);
				if (hidden) return hidden;

				const to = resolveDestination(app, source, toVaultPath(app, str(args.to)));
				if (to === source.path) return `Error: ${source.path} is already there.`;
				if (app.vault.getAbstractFileByPath(to)) {
					return `Error: "${to}" already exists. Pick another name, or move the existing one first.`;
				}

				// A move is a removal at one end and a creation at the other, so
				// it needs permission at both — asked once, for the whole move.
				const denied = await ensureMovable(ctx, source.path, to);
				if (denied) return denied;

				const parent = parentFolder(to);
				if (parent) await ensureFolder(app, parent);
				return await moveThroughObsidian(app, source, to);
			}

			case 'create_folder': {
				const p = toVaultPath(app, str(args.path));
				if (!p) return 'Error: a folder path is required.';
				const existing = app.vault.getAbstractFileByPath(p);
				if (existing instanceof TFolder) return `${p} already exists.`;
				if (existing) return `Error: "${p}" is a file, not a folder.`;
				const denied = await ensureFolderAllowed(ctx, p);
				if (denied) return denied;
				await ensureFolder(app, p);
				return `Created folder ${p}`;
			}

			case 'remember': {
				if (!settings.useMemory) {
					return 'Error: operating memory is disabled in settings.';
				}
				const path = normalizePath(settings.memoryFile);
				if (!path) return 'Error: no memory file is configured.';
				const content = str(args.content);
				if (!content.trim()) return 'Error: memory content is required.';
				const existing = app.vault.getAbstractFileByPath(path);
				if (str(args.mode) !== 'replace' && existing instanceof TFile) {
					const cur = await app.vault.cachedRead(existing);
					const denied = await ensureWritable(ctx, 'remember', path, `${cur.trimEnd()}\n\n${content}`);
					if (denied) return denied;
					await processWrite(ctx, existing, (fresh) => `${fresh.trimEnd()}\n\n${content}`);
					return `Remembered (appended to ${path}).`;
				}
				await writeFile(ctx, 'remember', path, content);
				return `Remembered (saved ${path}).`;
			}

			case 'wiki_home': {
				const p = wikiHomePath(settings);
				const f = app.vault.getAbstractFileByPath(p);
				if (!(f instanceof TFile)) {
					return `The wiki has no "${p}" page yet. Create it with update_wiki: a short, curated table of contents whose [[links]] lead to the top-level topics. Link every new wiki page into it.`;
				}
				return await app.vault.cachedRead(f);
			}

			case 'wiki_page': {
				const title = sanitizeTitle(str(args.title));
				if (!title) return 'Error: a wiki page title is required.';
				const p = normalizePath(`${settings.wikiFolder}/${title}.md`);
				const f = app.vault.getAbstractFileByPath(p);
				if (!(f instanceof TFile)) {
					return `Error: no wiki page "${title}". Check wiki_home or list_wiki for the pages that exist.`;
				}
				const content = await app.vault.cachedRead(f);
				return `${content}\n\n---\n${describeLinks(app, settings, p)}`;
			}

			case 'semantic_search': {
				if (!settings.useRag) return 'Error: semantic search is disabled in settings.';
				const q = str(args.query).trim();
				if (!q) return 'Error: a query is required.';
				const limit = Math.min(Math.max(Number(args.limit) || settings.ragTopK, 1), 20);
				return await ctx.rag.search(q, limit);
			}

			case 'open_files': {
				if (!settings.useOpenFiles) {
					return 'Error: seeing what is open in Obsidian is disabled in settings.';
				}
				return describeOpenFiles(app, settings);
			}

			case 'list_wiki':
				return buildWikiIndex(app, settings);

			case 'links': {
				const found = findNote(app, settings, str(args.path));
				if (!found.file) return notFoundMessage(found);
				return describeLinks(app, settings, found.file.path);
			}

			case 'update_wiki': {
				const title = sanitizeTitle(str(args.title));
				if (!title) return 'Error: a wiki title is required.';
				const path = normalizePath(`${settings.wikiFolder}/${title}.md`);
				const content = str(args.content);
				const existing = app.vault.getAbstractFileByPath(path);
				if (str(args.mode) === 'append' && existing instanceof TFile) {
					const cur = await app.vault.cachedRead(existing);
					const denied = await ensureWritable(ctx, 'update_wiki', path, `${cur}\n\n${content}`);
					if (denied) return denied;
					await processWrite(ctx, existing, (fresh) => `${fresh}\n\n${content}`);
					return `Appended to ${path}`;
				}
				return await writeFile(ctx, 'update_wiki', path, content);
			}

			default: {
				if (name.startsWith('mcp__')) return await callMcp(ctx, name, argsJson);
				// Not one of ours: run the vault equivalent when that is safe,
				// otherwise say which tool the model should have called.
				const available = offered ?? new Set(activeToolSpecs(settings).map((t) => t.name));
				const redirect = redirectTool(name, available);
				if (redirect.run && redirect.run !== name) {
					return await executeTool(ctx, redirect.run, JSON.stringify(args), available);
				}
				return `Error: ${redirect.message ?? `unknown tool "${name}".`}`;
			}
		}
	} catch (e) {
		return `Error running ${name}: ${e instanceof Error ? e.message : String(e)}`;
	}
}
