/**
 * Addressing part of a note instead of all of it.
 *
 * The unit is the heading section, because Obsidian already defines one:
 * resolveSubpath is the same function that decides what [[note#heading]] points
 * at, and it ends a section at the next heading of the same or higher level, so
 * a section carries its subsections. Writing our own heading scanner would be a
 * second definition of "section" that could disagree with the one the app
 * renders — including with the wikilink inliner, which resolves through here.
 */
import { App, TFile, resolveSubpath } from 'obsidian';

export interface SectionRange {
	/** Character offsets into the file text. */
	start: number;
	end: number;
	/** What the section is called, for headers and "inlined from" lines. */
	label: string;
}

/** Split "Notes/Ideas.md#Chunking" into its path and its "#Chunking" subpath. */
export function splitSubpath(raw: string): { path: string; subpath: string } {
	const hash = raw.indexOf('#');
	if (hash === -1) return { path: raw, subpath: '' };
	return { path: raw.slice(0, hash), subpath: raw.slice(hash) };
}

/**
 * The byte range of `subpath` ("#Heading", "#^blockid") within `file`, or null
 * when the cache has no such anchor. An empty subpath means the whole file.
 *
 * resolveSubpath reports `end: null` for the last section of a note, which
 * means "to the end of the file" rather than "empty".
 */
export function sectionRange(app: App, file: TFile, subpath: string, length: number): SectionRange | null {
	if (!subpath) return { start: 0, end: length, label: file.basename };
	const cache = app.metadataCache.getFileCache(file);
	if (!cache) return null;
	const found = resolveSubpath(cache, subpath);
	if (!found) return null;
	return {
		start: found.start.offset,
		end: found.end?.offset ?? length,
		label: `${file.basename}${subpath}`,
	};
}

/** Every heading in a note, in document order. Empty when nothing is cached. */
export function headings(app: App, file: TFile): { heading: string; level: number; line: number }[] {
	const cache = app.metadataCache.getFileCache(file);
	return (cache?.headings ?? []).map((h) => ({
		heading: h.heading,
		level: h.level,
		line: h.position.start.line + 1,
	}));
}

/**
 * The "I could not find that heading" message, naming the ones that exist —
 * the same ethic as paths.ts naming near-miss files, and for the same reason:
 * it turns a dead end into one more round instead of a guess.
 */
export function noSuchSection(app: App, file: TFile, subpath: string): string {
	const list = headings(app, file);
	if (!list.length) {
		return (
			`Error: no "${subpath}" in ${file.path}, and Obsidian has no headings cached for it ` +
			'(a note written moments ago may not be parsed yet). Read the whole note with read_file.'
		);
	}
	return (
		`Error: no "${subpath}" in ${file.path}. Headings: ${list.map((h) => h.heading).join(', ')}.` +
		' A block reference is written "#^blockid".'
	);
}

/** The `outline` tool's output: the shape of a note, with none of its prose. */
export function describeOutline(app: App, file: TFile, text: string): string {
	const cache = app.metadataCache.getFileCache(file);
	const list = headings(app, file);
	const lines = text.split('\n').length;

	const counts = [
		`${lines} lines`,
		`${list.length} heading(s)`,
		`${(cache?.links ?? []).length} link(s)`,
		`${(cache?.tags ?? []).length} tag(s)`,
	];
	const out: string[] = [`${file.path} — ${counts.join(', ')}`];

	// Keys only: a frontmatter field can hold a paragraph, and this tool exists
	// precisely so that a caller can look at a note without loading its prose.
	const keys = Object.keys(cache?.frontmatter ?? {}).filter((k) => k !== 'position');
	if (keys.length) out.push(`frontmatter: ${keys.join(', ')}`);

	if (!list.length) {
		out.push('(no headings — read_file is the only way into this note)');
		return out.join('\n');
	}
	for (let i = 0; i < list.length; i++) {
		const h = list[i];
		if (!h) continue;
		// A section runs to the next heading at the same or higher level, which
		// is what resolveSubpath will hand back for it.
		const next = list.slice(i + 1).find((n) => n.level <= h.level);
		const until = next ? next.line - 1 : lines;
		out.push(`${'  '.repeat(h.level - 1)}${'#'.repeat(h.level)} ${h.heading}  (lines ${h.line}–${until})`);
	}
	return out.join('\n');
}

/**
 * Replace or extend one section's body, returning the new file text.
 *
 * The heading line itself is never touched: the anchor the range was resolved
 * from has to survive the write, and letting a section rewrite its own heading
 * is a good way to lose everything below it to an off-by-one. `append` inserts
 * at the end of the section — before the next heading — which is the whole
 * reason this exists rather than append_file.
 *
 * Callers must pass a heading range, not a block one (see isBlockRef): a block
 * reference's first line is content, and treating it as a heading would bury it.
 */
export function spliceSection(
	text: string,
	range: SectionRange,
	body: string,
	mode: 'replace' | 'append',
): string {
	const section = text.slice(range.start, range.end);
	const firstBreak = section.indexOf('\n');
	// The heading line is kept verbatim; everything after it is the body.
	const headEnd = range.start + (firstBreak === -1 ? section.length : firstBreak);
	const head = text.slice(0, headEnd);
	const existing = firstBreak === -1 ? '' : section.slice(firstBreak + 1);
	const tail = text.slice(range.end);

	const added = body.trim();
	const kept = mode === 'append' ? existing.trim() : '';
	const middle = kept ? `${kept}\n\n${added}` : added;

	// Exactly one blank line after the heading and before whatever follows the
	// section, so repeated edits neither weld paragraphs together nor pile up
	// blank lines at the seam.
	const rest = tail.replace(/^\n+/, '');
	return `${head}\n\n${middle}\n${rest ? `\n${rest}` : ''}`;
}

/** True for a block reference ("#^id"), which write_section will not splice. */
export function isBlockRef(subpath: string): boolean {
	return subpath.startsWith('#^');
}
