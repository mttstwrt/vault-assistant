/**
 * Resolving the [[links]] you type in the chat box, before the model sees them.
 *
 * A wikilink typed into a chat box is an unambiguous "this note, please", and
 * everything needed to honour it is already loaded: getFirstLinkpathDest for
 * the note, resolveSubpath (via tools/sections) for the #section. So this runs
 * as a parser — no model call, never throws — and attaches the text to the
 * message rather than making the agent spend a tool round guessing.
 *
 * The attachment goes into the message itself rather than into the system
 * prompt, unlike the pre-pass and open-files blocks: those describe *now* and
 * are rebuilt each turn, while a note pulled in on turn one is still the
 * subject on turn five. It also has to be in the message for a reopened
 * transcript to give the model the context it had the first time.
 */
import { App, TFile } from 'obsidian';
import { VaultAssistantSettings } from './settings';
import { isReadable } from './permissions';
import { sectionRange, splitSubpath } from './tools/sections';

/** Per-link and per-message ceilings on how much text may be attached. */
const MAX_PER_LINK = 4000;
const MAX_TOTAL = 12000;

/** Fence delimiters. Plain lines rather than a callout, which would need a
 *  "> " on every line and would mangle any code block inside the note. */
const FENCE_START = '--- inlined from ';
const FENCE_END = '--- end inlined ---';

export interface Inlined {
	/** The link as typed, e.g. "Notes/Ideas#Chunking". */
	link: string;
	path: string;
	label: string;
	chars: number;
}

export interface Expansion {
	/** Text to append to the user's message, or '' when there is nothing to add. */
	block: string;
	inlined: Inlined[];
	/** Links that resolved to nothing, with the closest note named where there is one. */
	missed: { link: string; near: string | null }[];
	/** Links skipped because the note is in a blocked folder. */
	blocked: string[];
	/** Links left out because the message hit its budget. */
	deferred: string[];
}

/** True while `index` sits inside a fenced code block, so ```[[x]]``` is left alone. */
function codeFenceMask(text: string): boolean[] {
	const mask: boolean[] = new Array<boolean>(text.length).fill(false);
	const fence = /^(?: {0,3})(```+|~~~+)/gm;
	let open: number | null = null;
	for (let m = fence.exec(text); m; m = fence.exec(text)) {
		if (open === null) open = m.index;
		else {
			for (let i = open; i < m.index + m[0].length && i < mask.length; i++) mask[i] = true;
			open = null;
		}
	}
	if (open !== null) for (let i = open; i < mask.length; i++) mask[i] = true;
	return mask;
}

/** Every [[link]] and ![[embed]] in the message, in order, outside code fences. */
function findLinks(message: string): string[] {
	const mask = codeFenceMask(message);
	const found: string[] = [];
	const re = /!?\[\[([^\]\n]+)\]\]/g;
	for (let m = re.exec(message); m; m = re.exec(message)) {
		if (mask[m.index]) continue;
		const inner = (m[1] ?? '').split('|')[0]?.trim();
		if (inner) found.push(inner);
	}
	return found;
}

/**
 * Edit distance counting a transposition as one edit, not two, and given up on
 * once it exceeds `max`. Transpositions matter here because "Idaes" for
 * "Ideas" is the mistake people actually make typing a name, and plain
 * Levenshtein scores it 2 — the same as two unrelated wrong letters.
 */
function editDistance(a: string, b: string, max: number): number {
	if (Math.abs(a.length - b.length) > max) return max + 1;
	let twoBack: number[] = [];
	let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		const row = [i];
		let best = i;
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			let v = Math.min((row[j - 1] ?? 0) + 1, (prev[j] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
				v = Math.min(v, (twoBack[j - 2] ?? 0) + 1);
			}
			row[j] = v;
			if (v < best) best = v;
		}
		if (best > max) return max + 1;
		twoBack = prev;
		prev = row;
	}
	return prev[b.length] ?? max + 1;
}

/**
 * The closest note to a link that matched nothing — the near-miss ethic of
 * paths.ts. A substring match first (a half-remembered name), then a typo:
 * "Idaes" for "Ideas" is a transposition, which no substring test catches and
 * which is the mistake people actually make when typing a link by hand.
 */
function nearest(app: App, settings: VaultAssistantSettings, linkpath: string): string | null {
	const base = (linkpath.split('/').pop() ?? '').toLowerCase();
	if (!base) return null;
	const files = app.vault.getMarkdownFiles().filter((f) => isReadable(f.path, settings));

	const substring = files.find(
		(f) => f.basename.toLowerCase().includes(base) || base.includes(f.basename.toLowerCase()),
	);
	if (substring) return substring.path;

	const budget = Math.max(1, Math.floor(base.length / 4));
	let best: { path: string; distance: number } | null = null;
	for (const f of files) {
		const d = editDistance(base, f.basename.toLowerCase(), budget);
		if (d <= budget && (!best || d < best.distance)) best = { path: f.path, distance: d };
	}
	return best ? best.path : null;
}

/** One attached note, fenced and attributed. */
function fence(link: string, label: string, body: string, truncated: boolean): string {
	const note = truncated ? ', truncated — read_file for the rest' : '';
	return `${FENCE_START}[[${link}]] (${label}, ${body.length} chars${note}) ---\n${body}\n${FENCE_END}`;
}

/**
 * Resolve the links in `message` and build the text to attach to it.
 *
 * `sourcePath` is the note the user is looking at, so a link resolves the way
 * it would if typed in that note; '' resolves from the vault root.
 */
export async function expandWikilinks(
	app: App,
	settings: VaultAssistantSettings,
	message: string,
	sourcePath: string,
): Promise<Expansion> {
	const empty: Expansion = { block: '', inlined: [], missed: [], blocked: [], deferred: [] };
	const links = findLinks(message);
	if (!links.length) return empty;

	const result: Expansion = { ...empty, inlined: [], missed: [], blocked: [], deferred: [] };
	const parts: string[] = [];
	const seen = new Set<string>();
	let budget = MAX_TOTAL;

	for (const link of links) {
		const { path, subpath } = splitSubpath(link);
		const file = app.metadataCache.getFirstLinkpathDest(path, sourcePath);
		if (!(file instanceof TFile)) {
			result.missed.push({ link, near: nearest(app, settings, path) });
			continue;
		}
		if (!isReadable(file.path, settings)) {
			result.blocked.push(link);
			continue;
		}
		const key = `${file.path}${subpath.toLowerCase()}`;
		if (seen.has(key)) continue;
		seen.add(key);

		// Budget exhausted: name the rest rather than truncating mid-note. This
		// is also what makes "here is a list of twelve links" behave, without a
		// rule about how many links means the user meant them as text.
		if (budget <= 0) {
			result.deferred.push(link);
			continue;
		}

		const text = await app.vault.cachedRead(file);
		const range = sectionRange(app, file, subpath, text.length);
		if (!range) {
			result.missed.push({ link, near: file.path });
			continue;
		}

		const whole = text.slice(range.start, range.end).trim();
		const cap = Math.min(MAX_PER_LINK, budget);
		const body = whole.length > cap ? whole.slice(0, cap) : whole;
		if (!body) continue;

		budget -= body.length;
		const label = subpath ? (subpath.startsWith('#^') ? 'block' : 'heading section') : 'whole note';
		parts.push(fence(`${file.path}${subpath}`, label, body, body.length < whole.length));
		result.inlined.push({ link, path: file.path, label, chars: body.length });
	}

	if (!parts.length && !result.deferred.length) return result;
	const tail = result.deferred.length
		? `\n\n(Also linked, not attached: ${result.deferred.map((l) => `[[${l}]]`).join(', ')} — read them with read_file if you need them.)`
		: '';
	result.block = parts.length ? `\n\n${parts.join('\n\n')}${tail}` : tail.trimStart();
	return result;
}

/**
 * Track whether a transcript line sits inside an inlined fence.
 *
 * Both the transcript parser and the conversation chunker need this: an
 * attached note may itself be a saved conversation, whose "## 🧑 You" headings
 * would otherwise split one turn into several on reopen, and its text is a copy
 * of a note that is already indexed, so embedding it would return the same
 * passage twice. Fixing the readers rather than escaping the content — the
 * model should see the note exactly as it is written.
 */
export function makeFenceTracker(): (line: string) => boolean {
	let inside = false;
	return (line: string): boolean => {
		if (!inside && line.startsWith(FENCE_START)) {
			inside = true;
			return true;
		}
		if (inside && line.startsWith(FENCE_END)) {
			inside = false;
			return true;
		}
		return inside;
	};
}
