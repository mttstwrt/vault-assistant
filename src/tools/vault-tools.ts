import { App, TFile, TFolder, normalizePath } from 'obsidian';
import { VaultAssistantSettings } from '../settings';
import { ApprovalRequest, ApprovalResult, ToolSpec } from '../types';
import { displayScopes, isReadable, isWritable, parentFolder, writeScopes } from '../permissions';
import { McpManager } from '../mcp/manager';
import { RagIndexer } from '../rag/indexer';
import { buildWikiIndex, describeLinks, wikiHomePath } from './graph';
import { describeOpenFiles } from './workspace';
import { normalizeArgs, redirectTool } from './aliases';
import { findFolder, findNote, notFoundMessage, toVaultPath } from './paths';

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
}

export const TOOL_SPECS: ToolSpec[] = [
	{
		name: 'list_files',
		description:
			'List the files and folders directly inside a vault folder. Use an empty or omitted path for the vault root.',
		parameters: {
			type: 'object',
			properties: {
				path: {
					type: 'string',
					description: 'Folder path relative to the vault root. Empty/omitted = root.',
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
		name: 'search',
		description:
			'Full-text search across markdown notes. Returns matching file paths with short snippets.',
		parameters: {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'Text to search for (case-insensitive).' },
				limit: { type: 'number', description: 'Max results (default 20, max 50).' },
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

/** Create a folder and any missing parents. */
async function ensureFolder(app: App, folder: string): Promise<void> {
	const parts = normalizePath(folder).split('/').filter(Boolean);
	let cur = '';
	for (const p of parts) {
		cur = cur ? `${cur}/${p}` : p;
		if (!app.vault.getAbstractFileByPath(cur)) {
			try {
				await app.vault.createFolder(cur);
			} catch {
				// Folder may already exist (race); ignore.
			}
		}
	}
}

/**
 * Decide whether `path` may be written. Returns null to proceed, or an error
 * string to hand back to the model when the user denies. Prompts the user for
 * out-of-scope writes and may widen the allowlist (for this session, or
 * persistently) as a side effect of an "always allow" grant.
 */
async function ensureWritable(ctx: ToolContext, tool: string, path: string): Promise<string | null> {
	const p = normalizePath(path);
	if (isWritable(p, ctx.settings) || ctx.sessionWrites.has(p)) return null;

	const folder = parentFolder(p);
	const decision = await ctx.requestApproval({ kind: 'write', tool, path: p, folder });
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

/** Create or overwrite a file, with no permission check. */
async function doWrite(app: App, path: string, content: string): Promise<string> {
	const p = normalizePath(path);
	const dir = parentFolder(p);
	if (dir) await ensureFolder(app, dir);

	const existing = app.vault.getAbstractFileByPath(p);
	if (existing instanceof TFile) {
		await app.vault.modify(existing, content);
		return `Updated ${p}`;
	}
	await app.vault.create(p, content);
	return `Created ${p}`;
}

/** Permission-checked create/overwrite. */
async function writeFile(
	ctx: ToolContext,
	tool: string,
	path: string,
	content: string,
): Promise<string> {
	const denied = await ensureWritable(ctx, tool, path);
	if (denied) return denied;
	return doWrite(ctx.app, path, content);
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
			case 'list_files': {
				const raw = typeof args.path === 'string' ? args.path : '';
				const folder = findFolder(app, raw);
				if (!folder) return `Error: no folder "${toVaultPath(app, raw)}" in the vault.`;
				const lines = folder.children
					.filter((c) => c instanceof TFolder || isReadable(c.path, settings))
					.map((c) => (c instanceof TFolder ? `${c.path}/` : c.path))
					.sort();
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
				const q = str(args.query).toLowerCase();
				if (!q) return 'Error: a query is required.';
				const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 50);
				const results: string[] = [];
				for (const file of app.vault.getMarkdownFiles()) {
					if (!isReadable(file.path, settings)) continue;
					const text = await app.vault.cachedRead(file);
					const idx = text.toLowerCase().indexOf(q);
					if (idx >= 0) {
						const snippet = text
							.slice(Math.max(0, idx - 40), idx + 80)
							.replace(/\s+/g, ' ')
							.trim();
						results.push(`${file.path}: …${snippet}…`);
						if (results.length >= limit) break;
					}
				}
				return results.length ? results.join('\n') : 'No matches found.';
			}

			case 'write_file':
				return await writeFile(
					ctx,
					'write_file',
					toVaultPath(app, str(args.path)),
					str(args.content),
				);

			case 'append_file': {
				const p = toVaultPath(app, str(args.path));
				const denied = await ensureWritable(ctx, 'append_file', p);
				if (denied) return denied;
				const existing = app.vault.getAbstractFileByPath(p);
				if (existing instanceof TFile) {
					const cur = await app.vault.read(existing);
					await app.vault.modify(existing, cur + str(args.content));
					return `Appended to ${p}`;
				}
				return await doWrite(app, p, str(args.content));
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
					const denied = await ensureWritable(ctx, 'remember', path);
					if (denied) return denied;
					const cur = await app.vault.read(existing);
					await app.vault.modify(existing, `${cur.trimEnd()}\n\n${content}`);
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
					const denied = await ensureWritable(ctx, 'update_wiki', path);
					if (denied) return denied;
					const cur = await app.vault.read(existing);
					await app.vault.modify(existing, `${cur}\n\n${content}`);
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
