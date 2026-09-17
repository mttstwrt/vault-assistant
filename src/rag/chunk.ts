import { TranscriptEntry } from '../types';
import { parseTranscript } from '../transcript';

/** One embeddable piece of a note: where it came from and its text. */
export interface Chunk {
	path: string;
	/** The nearest heading above the chunk, '' for preamble text. */
	heading: string;
	text: string;
}

/** Character budget per chunk — roughly a few hundred tokens. */
const MAX_CHARS = 1500;
/** Overlap carried between adjacent chunks of one long section. */
const OVERLAP = 200;
/** Fragments shorter than this carry no meaning worth a vector. */
const MIN_CHARS = 24;

/** Wrap one section into MAX_CHARS chunks, breaking at newlines/spaces. */
function wrapSection(path: string, heading: string, body: string): Chunk[] {
	const text = body.trim();
	if (text.length < MIN_CHARS) return [];
	if (text.length <= MAX_CHARS) return [{ path, heading, text }];

	const chunks: Chunk[] = [];
	let start = 0;
	while (start < text.length) {
		let end = Math.min(start + MAX_CHARS, text.length);
		if (end < text.length) {
			// Prefer to break at a paragraph/line/word boundary near the budget.
			const slice = text.slice(start, end);
			const breakAt = Math.max(slice.lastIndexOf('\n'), slice.lastIndexOf(' '));
			if (breakAt > MAX_CHARS / 2) end = start + breakAt;
		}
		const piece = text.slice(start, end).trim();
		if (piece.length >= MIN_CHARS) chunks.push({ path, heading, text: piece });
		if (end >= text.length) break;
		start = Math.max(end - OVERLAP, start + 1);
	}
	return chunks;
}

/**
 * Markdown-aware chunking: split a note on headings, then wrap each section to
 * the character budget with a small overlap. Each chunk keeps the heading it
 * sits under so results read as "path › heading".
 */
export function chunkMarkdown(path: string, text: string): Chunk[] {
	const chunks: Chunk[] = [];
	let heading = '';
	let body: string[] = [];

	const flush = () => {
		chunks.push(...wrapSection(path, heading, body.join('\n')));
		body = [];
	};

	for (const line of text.split('\n')) {
		const m = /^#{1,6}\s+(.*)$/.exec(line);
		if (m) {
			flush();
			heading = (m[1] ?? '').trim();
		} else {
			body.push(line);
		}
	}
	flush();
	return chunks;
}

/**
 * A filtered view of a saved conversation transcript, safe to embed as memory:
 * the user's turns plus the agent's FINAL answer per turn.
 *
 * The filtering is structural rather than textual, because the transcript
 * parser already knows what every part of a conversation is. So tool calls and
 * their output, write diffs, approvals and errors are dropped by never being
 * assistant prose; the model's reasoning is dropped because it is its own field
 * and not part of the answer; and a note the [[link]] expander attached is
 * dropped because the record keeps it apart from what was typed — it is a copy
 * of a note already indexed under its own path, and embedding it here would
 * return the same passage twice under two names.
 *
 * Intermediate assistant turns go too: that is scratch work on the way to an
 * answer, and where a wrong statement lives until it is corrected.
 */
export function chunkConversation(path: string, text: string): Chunk[] {
	const entries = parseTranscript(text);

	const said = entries.filter(
		(e): e is Extract<TranscriptEntry, { kind: 'user' | 'assistant' }> =>
			(e.kind === 'user' || e.kind === 'assistant') && !!e.text.trim(),
	);
	const kept = said.filter(
		(e, i) => e.kind === 'user' || i === said.length - 1 || said[i + 1]?.kind === 'user',
	);

	const chunks: Chunk[] = [];
	for (const e of kept) {
		chunks.push(...wrapSection(path, e.kind === 'user' ? 'You' : 'Assistant', e.text));
	}
	return chunks;
}
