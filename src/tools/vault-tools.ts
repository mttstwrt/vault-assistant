import { App, TFile, TFolder, normalizePath } from 'obsidian';
import { AIChatSettings } from '../settings';
import { ToolSpec } from '../types';
import { displayScopes, isReadable, isWritable, writeScopes } from '../permissions';
import { buildWikiIndex, describeLinks } from './graph';

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
		name: 'list_wiki',
		description:
			'List every existing wiki note and how it links to other notes and the rest of the vault. Call this before creating or updating wiki notes so the wiki grows coherently: extend and cross-link existing pages instead of duplicating them.',
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

async function writeFile(
	app: App,
	settings: AIChatSettings,
	path: string,
	content: string,
): Promise<string> {
	const p = normalizePath(path);
	if (!isWritable(p, settings)) {
		return `Error: writing to "${p}" is not permitted. Writable folders: ${displayScopes(writeScopes(settings))}.`;
	}
	const dir = p.split('/').slice(0, -1).join('/');
	if (dir) await ensureFolder(app, dir);

	const existing = app.vault.getAbstractFileByPath(p);
	if (existing instanceof TFile) {
		await app.vault.modify(existing, content);
		return `Updated ${p}`;
	}
	await app.vault.create(p, content);
	return `Created ${p}`;
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

/** Run a tool by name and return a string result for the model. */
export async function executeTool(
	app: App,
	settings: AIChatSettings,
	name: string,
	argsJson: string,
): Promise<string> {
	let args: Record<string, unknown>;
	try {
		args = JSON.parse(argsJson || '{}') as Record<string, unknown>;
	} catch {
		return 'Error: tool arguments were not valid JSON.';
	}

	try {
		switch (name) {
			case 'list_files': {
				const raw = typeof args.path === 'string' ? args.path : '';
				const p = raw ? normalizePath(raw) : '';
				const folder = p ? app.vault.getAbstractFileByPath(p) : app.vault.getRoot();
				if (!(folder instanceof TFolder)) return `Error: not a folder: "${p}".`;
				const lines = folder.children
					.filter((c) => c instanceof TFolder || isReadable(c.path, settings))
					.map((c) => (c instanceof TFolder ? `${c.path}/` : c.path))
					.sort();
				return lines.length ? lines.join('\n') : '(empty folder)';
			}

			case 'read_file': {
				const p = normalizePath(str(args.path));
				const f = app.vault.getAbstractFileByPath(p);
				if (!(f instanceof TFile)) return `Error: file not found: "${p}".`;
				if (!isReadable(p, settings)) return `Error: reading "${p}" is not permitted.`;
				return await app.vault.cachedRead(f);
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
				return await writeFile(app, settings, str(args.path), str(args.content));

			case 'append_file': {
				const p = normalizePath(str(args.path));
				if (!isWritable(p, settings)) {
					return `Error: writing to "${p}" is not permitted. Writable folders: ${displayScopes(writeScopes(settings))}.`;
				}
				const existing = app.vault.getAbstractFileByPath(p);
				if (existing instanceof TFile) {
					const cur = await app.vault.read(existing);
					await app.vault.modify(existing, cur + str(args.content));
					return `Appended to ${p}`;
				}
				return await writeFile(app, settings, p, str(args.content));
			}

			case 'list_wiki':
				return buildWikiIndex(app, settings);

			case 'links':
				return describeLinks(app, settings, str(args.path));

			case 'update_wiki': {
				const title = sanitizeTitle(str(args.title));
				if (!title) return 'Error: a wiki title is required.';
				const path = normalizePath(`${settings.wikiFolder}/${title}.md`);
				const content = str(args.content);
				const existing = app.vault.getAbstractFileByPath(path);
				if (str(args.mode) === 'append' && existing instanceof TFile) {
					if (!isWritable(path, settings)) {
						return `Error: writing to "${path}" is not permitted.`;
					}
					const cur = await app.vault.read(existing);
					await app.vault.modify(existing, `${cur}\n\n${content}`);
					return `Appended to ${path}`;
				}
				return await writeFile(app, settings, path, content);
			}

			default:
				return `Error: unknown tool "${name}".`;
		}
	} catch (e) {
		return `Error running ${name}: ${e instanceof Error ? e.message : String(e)}`;
	}
}
