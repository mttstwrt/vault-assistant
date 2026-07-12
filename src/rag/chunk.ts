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
 * A filtered view of a saved conversation transcript, safe to embed as
 * memory: the user's turns plus the agent's FINAL answer per turn. Tool-call
 * lines and intermediate assistant messages are dropped — that is scratch
 * work (and where wrong pre-correction statements live), not memory.
 *
 * Relies on the transcript shape written by conversation.ts:
 * "## 🧑 You" / "## 🤖 Assistant" sections and "> 🔧 `tool(...)`" lines.
 */
export function chunkConversation(path: string, text: string): Chunk[] {
	interface Turn {
		role: 'user' | 'assistant';
		lines: string[];
	}
	const turns: Turn[] = [];
	let current: Turn | null = null;

	for (const line of text.split('\n')) {
		if (/^## 🧑 You\s*$/.test(line)) {
			current = { role: 'user', lines: [] };
			turns.push(current);
		} else if (/^## 🤖 Assistant\s*$/.test(line)) {
			current = { role: 'assistant', lines: [] };
			turns.push(current);
		} else if (current && !line.startsWith('> 🔧')) {
			// Frontmatter and anything before the first section is skipped.
			current.lines.push(line);
		}
	}

	// Keep user turns; of consecutive assistant turns, keep only the last —
	// that is the final answer the intermediate steps were building toward.
	const kept = turns.filter(
		(t, i) => t.role === 'user' || i === turns.length - 1 || turns[i + 1]?.role === 'user',
	);

	const chunks: Chunk[] = [];
	for (const t of kept) {
		const heading = t.role === 'user' ? 'You' : 'Assistant';
		chunks.push(...wrapSection(path, heading, t.lines.join('\n')));
	}
	return chunks;
}
