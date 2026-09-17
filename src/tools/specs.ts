/**
 * The tools the model is told it has.
 *
 * Separate from the dispatch in ./vault-tools because they answer different
 * questions and have different readers: this is what goes into every request's
 * schema block, and ../prompts and ./capabilities import it only to enumerate
 * names. Asking "which tools exist" should not drag in what happens when one is
 * called.
 *
 * Descriptions carry weight here. Every request pays for all of them, and a
 * description that says *when* to reach for a tool is what stops the wrong one
 * being picked — see docs/future-work.md for what that costs and what was
 * measured.
 */
import { ToolSpec } from '../types';
import { VaultAssistantSettings } from '../settings';

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
