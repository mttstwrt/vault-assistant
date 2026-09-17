/**
 * The fence that marks a note pulled into a message.
 *
 * Its own module because four things need to agree about it and none of them
 * owns it: ./wikilinks writes it, ./transcript splits a saved message back
 * apart on it, ./conversation must not read a heading inside it as a turn, and
 * ./rag/chunk must not embed a second copy of a note that is already indexed.
 * It lives apart from ./wikilinks so that the three readers do not have to pull
 * Obsidian in to know where a fence starts.
 *
 * Plain lines rather than a callout: a callout needs "> " on every line, which
 * would mangle any code block inside the note being attached.
 */

export const FENCE_START = '--- inlined from ';
export const FENCE_END = '--- end inlined ---';

/** One attached note, fenced and attributed. */
export function inlinedFence(link: string, label: string, body: string, truncated: boolean): string {
	const note = truncated ? ', truncated — read_file for the rest' : '';
	return `${FENCE_START}[[${link}]] (${label}, ${body.length} chars${note}) ---\n${body}\n${FENCE_END}`;
}

/**
 * Track whether a line sits inside an inlined fence.
 *
 * An attached note may itself be a saved conversation, whose own turn headings
 * would otherwise split one turn into several on reopen — and whose text is a
 * copy of a note that is already indexed, so embedding it would return the same
 * passage twice. Fixing the readers rather than escaping the content: the model
 * should see the note exactly as it is written.
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

/**
 * Split a stored user message into what was typed and what was attached to it.
 *
 * The two are one string on the wire, because the model is meant to read them
 * as one message. They are not one thing to a reader: the bubble shows the
 * sentence somebody wrote, not the sentence plus four thousand characters of
 * note, and a reopened conversation has to make the same distinction the live
 * one did.
 */
export function splitInlined(content: string): { text: string; block: string } {
	const at = content.indexOf(`\n${FENCE_START}`);
	if (at === -1) return { text: content, block: '' };
	return { text: content.slice(0, at).trimEnd(), block: content.slice(at) };
}
