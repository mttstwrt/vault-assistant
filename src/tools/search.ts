/**
 * Text search over the vault.
 *
 * Deliberately in-process rather than shelling out to grep or ripgrep: this
 * plugin is not desktop-only, so mobile has no shell at all, Windows has no
 * grep, and ripgrep is installed by default nowhere. The decisive reason is the
 * read blocklist — every other tool enforces it by calling isReadable, and
 * re-expressing it as --exclude-dir arguments would move the privacy boundary
 * into argv quoting. What a real grep would have given us is its *options*, not
 * a better regular-expression engine, so the options are implemented here under
 * the names grep uses for them.
 */
import { App, TFile } from 'obsidian';
import { VaultAssistantSettings } from '../settings';
import { isReadable } from '../permissions';
import { inFolder } from './graph';

/** Longest pattern accepted, as a crude bound on catastrophic backtracking. */
const MAX_PATTERN = 200;
/** How much of a matching line is echoed back. */
const MAX_LINE = 240;

export interface SearchOptions {
	query: string;
	regex: boolean;
	caseSensitive: boolean;
	wholeWord: boolean;
	invert: boolean;
	multiline: boolean;
	filesOnly: boolean;
	/** Folder to search inside; '' searches the whole readable vault. */
	scope: string;
	limit: number;
	maxPerFile: number;
	/** Lines of context either side of a hit. */
	context: number;
}

export interface Hit {
	path: string;
	/** 1-based, the way an editor counts. */
	line: number;
	text: string;
	/** Lines before/after, when context was asked for. */
	before: string[];
	after: string[];
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compile the query into a matcher. Returns a string instead of throwing when
 * the pattern is unusable — including the one platform difference that matters
 * here: lookbehind throws on iOS before 16.4, and a pattern supplied by a model
 * cannot be linted for it the way source can.
 */
function compile(o: SearchOptions): RegExp | string {
	if (o.query.length > MAX_PATTERN) {
		return `Error: search pattern is too long (${o.query.length} characters, max ${MAX_PATTERN}).`;
	}
	let source = o.regex ? o.query : escapeRegex(o.query);
	if (o.wholeWord) source = `\\b(?:${source})\\b`;
	const flags = `g${o.caseSensitive ? '' : 'i'}${o.multiline ? 'm' : ''}`;
	try {
		return new RegExp(source, flags);
	} catch (e) {
		const why = e instanceof Error ? e.message : String(e);
		return `Error: "${o.query}" is not a usable regular expression here: ${why}`;
	}
}

/** Trim a line for reporting, keeping it one line and bounded. */
function clip(line: string): string {
	const t = line.replace(/\t/g, '  ').trimEnd();
	return t.length > MAX_LINE ? `${t.slice(0, MAX_LINE)}…` : t;
}

/** Which files this search may look at, in a stable order. */
function candidates(app: App, settings: VaultAssistantSettings, scope: string): TFile[] {
	return app.vault
		.getMarkdownFiles()
		.filter((f) => isReadable(f.path, settings) && (!scope || inFolder(f.path, scope)))
		.sort((a, b) => a.path.localeCompare(b.path));
}

/** Line number (1-based) of a character offset, counting newlines before it. */
function lineAt(text: string, offset: number): number {
	let line = 1;
	for (let i = 0; i < offset && i < text.length; i++) if (text[i] === '\n') line++;
	return line;
}

/**
 * Run the search. Returns the hits, or an error string when the pattern itself
 * is the problem — the caller hands either straight to the model.
 */
export async function runSearch(
	app: App,
	settings: VaultAssistantSettings,
	o: SearchOptions,
): Promise<Hit[] | string> {
	const re = compile(o);
	if (typeof re === 'string') return re;

	const hits: Hit[] = [];
	for (const file of candidates(app, settings, o.scope)) {
		if (hits.length >= o.limit) break;
		const text = await app.vault.cachedRead(file);
		const lines = text.split('\n');
		let inFile = 0;

		const take = (line: number, body: string): boolean => {
			hits.push({
				path: file.path,
				line,
				text: clip(body),
				before: o.context ? lines.slice(Math.max(0, line - 1 - o.context), line - 1).map(clip) : [],
				after: o.context ? lines.slice(line, line + o.context).map(clip) : [],
			});
			inFile++;
			return hits.length >= o.limit || inFile >= o.maxPerFile;
		};

		// Multiline runs the pattern over the whole file and reports where each
		// match starts; the default runs it per line, which bounds how much text
		// any single exec can backtrack over.
		if (o.multiline && !o.invert) {
			re.lastIndex = 0;
			// A line is reported once however many times the pattern matches
			// inside it, which is what grep does and what stops a zero-width
			// pattern like `x*` from reporting the same line per character.
			let lastLine = 0;
			for (let m = re.exec(text); m; m = re.exec(text)) {
				const line = lineAt(text, m.index);
				if (line !== lastLine) {
					lastLine = line;
					if (take(line, lines[line - 1] ?? m[0])) break;
				}
				// A zero-length match would spin forever without this.
				if (m.index === re.lastIndex) re.lastIndex++;
			}
		} else {
			for (let i = 0; i < lines.length; i++) {
				const body = lines[i] ?? '';
				re.lastIndex = 0;
				if (re.test(body) === o.invert) continue;
				if (take(i + 1, body)) break;
			}
		}
	}
	return hits;
}

/** The `search` tool's output: grep-shaped, because that shape is universal. */
export function renderHits(hits: Hit[], o: SearchOptions): string {
	if (!hits.length) return 'No matches found.';

	const files = new Set(hits.map((h) => h.path));
	if (o.filesOnly) {
		return [...files].join('\n') + `\n${files.size} file(s) matched.`;
	}

	const lines: string[] = [];
	for (const h of hits) {
		for (let i = 0; i < h.before.length; i++) {
			lines.push(`${h.path}-${h.line - h.before.length + i}- ${h.before[i]}`);
		}
		lines.push(`${h.path}:${h.line}: ${h.text}`);
		for (let i = 0; i < h.after.length; i++) {
			lines.push(`${h.path}-${h.line + 1 + i}- ${h.after[i]}`);
		}
		if (o.context) lines.push('--');
	}
	lines.push(`${hits.length} match(es) in ${files.size} file(s).`);
	return lines.join('\n');
}

/**
 * The pre-pass's shape: one snippet per file, no line numbers. Same scan, a
 * different rendering — the pre-pass injects prose into a prompt rather than
 * locations for the model to act on.
 */
export async function searchSnippets(
	app: App,
	settings: VaultAssistantSettings,
	query: string,
	limit: number,
): Promise<string> {
	const hits = await runSearch(app, settings, {
		query,
		regex: false,
		caseSensitive: false,
		wholeWord: false,
		invert: false,
		multiline: false,
		filesOnly: false,
		scope: '',
		limit,
		maxPerFile: 1,
		context: 0,
	});
	if (typeof hits === 'string') return '';
	return hits.map((h) => `${h.path}: …${h.text}…`).join('\n');
}
