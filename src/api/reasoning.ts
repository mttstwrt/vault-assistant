/**
 * Reasoning ("thinking") extraction.
 *
 * Endpoints expose a model's reasoning in one of two ways: as a separate
 * `reasoning_content` field on the delta/message (llama.cpp with a reasoning
 * format, OpenRouter, DeepSeek), or inline in the content wrapped in
 * `<think>` tags. This module handles the inline form, incrementally, so a tag
 * split across two stream chunks is still recognised.
 */

/** Tag names models wrap their reasoning in. */
const TAG_NAMES = ['think', 'thinking', 'reason', 'reasoning'];
const OPEN_TAGS = TAG_NAMES.map((t) => `<${t}>`);
const CLOSE_TAGS = TAG_NAMES.map((t) => `</${t}>`);

/** The closing tag that matches an opening one. */
function closingFor(open: string): string {
	return `</${open.slice(1)}`;
}

/** The earliest occurrence of any of `tags` in `text`. */
function firstOf(text: string, tags: string[]): { index: number; tag: string } | null {
	let best: { index: number; tag: string } | null = null;
	for (const tag of tags) {
		const index = text.indexOf(tag);
		if (index !== -1 && (!best || index < best.index)) best = { index, tag };
	}
	return best;
}

/**
 * Length of the longest tail of `text` that could still grow into one of
 * `tags` (e.g. "…done <thin" → 5). That tail is held back until the next
 * chunk decides whether it really is a tag.
 */
function partialTailLength(text: string, tags: string[]): number {
	let longest = 0;
	for (const tag of tags) {
		const max = Math.min(tag.length - 1, text.length);
		for (let len = max; len > longest; len--) {
			if (text.endsWith(tag.slice(0, len))) {
				longest = len;
				break;
			}
		}
	}
	return longest;
}

export interface ReasoningSplit {
	/** Text to show as the answer. */
	content: string;
	/** Text to show in the thinking section. */
	reasoning: string;
	/**
	 * A closing tag arrived without an opening one — the model was reasoning
	 * from its first token (a prefilled `<think>`), so everything emitted as
	 * content before this point was reasoning too.
	 */
	reclassifyPrior?: boolean;
}

/**
 * Splits a stream of content deltas into answer text and reasoning text.
 * Feed every delta through `push`, then `flush` once the stream ends.
 */
export class ThinkTagSplitter {
	/** Text held back because it might be the start of a tag. */
	private buf = '';
	/** The tag that ends the reasoning block we are inside, if any. */
	private closing: string | null = null;
	/** An unmatched closing tag only reclassifies the first time. */
	private reclassified = false;

	push(chunk: string): ReasoningSplit {
		this.buf += chunk;
		let content = '';
		let reasoning = '';
		let reclassifyPrior = false;

		for (;;) {
			if (this.closing) {
				const end = this.buf.indexOf(this.closing);
				if (end === -1) {
					const keep = partialTailLength(this.buf, CLOSE_TAGS);
					reasoning += this.buf.slice(0, this.buf.length - keep);
					this.buf = this.buf.slice(this.buf.length - keep);
					break;
				}
				reasoning += this.buf.slice(0, end);
				this.buf = this.buf.slice(end + this.closing.length);
				this.closing = null;
				continue;
			}

			const open = firstOf(this.buf, OPEN_TAGS);
			const close = this.reclassified ? null : firstOf(this.buf, CLOSE_TAGS);

			// A closing tag before any opening one: the whole turn so far was
			// reasoning that the server never marked as such.
			if (close && (!open || close.index < open.index)) {
				this.reclassified = true;
				reclassifyPrior = true;
				reasoning = content + reasoning + this.buf.slice(0, close.index);
				content = '';
				this.buf = this.buf.slice(close.index + close.tag.length);
				continue;
			}

			if (!open) {
				const keep = partialTailLength(this.buf, this.reclassified ? OPEN_TAGS : [...OPEN_TAGS, ...CLOSE_TAGS]);
				content += this.buf.slice(0, this.buf.length - keep);
				this.buf = this.buf.slice(this.buf.length - keep);
				break;
			}

			content += this.buf.slice(0, open.index);
			this.buf = this.buf.slice(open.index + open.tag.length);
			this.closing = closingFor(open.tag);
		}

		return reclassifyPrior ? { content, reasoning, reclassifyPrior } : { content, reasoning };
	}

	/** Release any held-back text once no more chunks are coming. */
	flush(): ReasoningSplit {
		const rest = this.buf;
		this.buf = '';
		if (!rest) return { content: '', reasoning: '' };
		return this.closing ? { content: '', reasoning: rest } : { content: rest, reasoning: '' };
	}
}

/** Split a complete (non-streamed) message into answer and reasoning. */
export function splitThinkTags(text: string): { content: string; reasoning: string } {
	const splitter = new ThinkTagSplitter();
	const a = splitter.push(text);
	const b = splitter.flush();
	return {
		content: (a.content + b.content).replace(/^\n+/, ''),
		reasoning: (a.reasoning + b.reasoning).trim(),
	};
}
