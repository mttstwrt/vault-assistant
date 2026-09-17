/**
 * The conversation as a note, and back again.
 *
 * A saved conversation has two audiences that pull in opposite directions: a
 * person reading it as a note months later, and this plugin reopening it to
 * carry on. The split that serves both is that small structured facts go into
 * HTML comments — which Obsidian renders as nothing at all, so they cost the
 * reader nothing — while the bulky, genuinely readable payloads (the model's
 * reasoning, what a tool returned, what a write changed) go into fenced blocks
 * that read as themselves.
 *
 * Fences rather than callouts, following the inliner in ./wikilinks: a callout
 * needs "> " on every line and mangles any code block inside it. Fence length
 * is computed per payload rather than fixed at three, which is CommonMark's own
 * rule and the only thing that makes a transcript survive containing another
 * transcript — a case this plugin reaches the first time the agent reads a
 * saved conversation.
 */
import { ChatMessage, ExpansionSummary, SerializedDiff, TranscriptEntry, TurnStats } from './types';
import { ApprovalRequest, ApprovalResult } from './types';
import { makeFenceTracker, splitInlined } from './inlined';

const USER_HEADING = '## 🧑 You';
const ASSISTANT_HEADING = '## 🤖 Assistant';

/**
 * Machine markers. Invisible in reading view, unambiguous to parse — unlike a
 * heading or an emoji prefix, either of which a tool result can contain.
 */
const MARK = {
	attached: 'va:attached',
	thinking: 'va:thinking',
	tool: 'va:tool',
	change: 'va:change',
	approval: 'va:approval',
	error: 'va:error',
	stats: 'va:stats',
} as const;

/** A fence longer than any run of backticks already inside `body`. */
function fenceFor(body: string): string {
	let longest = 0;
	for (const run of body.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
	return '`'.repeat(Math.max(3, longest + 1));
}

/** A payload as a fenced block that cannot be broken by its own contents. */
function fenced(body: string, language = ''): string {
	const fence = fenceFor(body);
	return `${fence}${language}\n${body}\n${fence}`;
}

/** `<!-- va:kind {json} -->`, or `<!-- va:kind -->` when there is nothing to carry. */
function marker(kind: string, data?: unknown): string {
	return data === undefined ? `<!-- ${kind} -->` : `<!-- ${kind} ${JSON.stringify(data)} -->`;
}

/** Read a marker line, returning its payload — `null` when the line is not one. */
function readMarker(line: string, kind: string): unknown {
	const prefix = `<!-- ${kind}`;
	const trimmed = line.trim();
	if (!trimmed.startsWith(prefix) || !trimmed.endsWith('-->')) return null;
	const body = trimmed.slice(prefix.length, -3).trim();
	if (!body) return {};
	try {
		return JSON.parse(body);
	} catch {
		return {};
	}
}

/** Which marker, if any, a line opens. */
function markerKind(line: string): string | null {
	const m = /^<!--\s*(va:[a-z]+)\b/.exec(line.trim());
	return m?.[1] ?? null;
}

// --- Rendering ---------------------------------------------------------------

function renderStats(stats: TurnStats | undefined, aborted: boolean | undefined): string[] {
	if (!stats && !aborted) return [];
	const parts: string[] = [];
	if (aborted) parts.push('Stopped');
	if (stats) {
		parts.push(`${(stats.elapsedMs / 1000).toFixed(1)}s`);
		if (stats.completionTokens) parts.push(`${stats.completionTokens} tokens`);
		if (stats.tokensPerSecond) parts.push(`${stats.tokensPerSecond.toFixed(1)} tok/s`);
	}
	// The visible half repeats what the marker carries, because a reader of the
	// note should see what the turn cost without the plugin rendering it.
	return [marker(MARK.stats, { stats, aborted }), `*${parts.join(' · ')}*`, ''];
}

function renderEntry(entry: TranscriptEntry): string[] {
	switch (entry.kind) {
		case 'user': {
			const lines = [USER_HEADING, '', entry.text, ''];
			if (entry.block) lines.push(entry.block.trim(), '');
			if (entry.attached) lines.push(marker(MARK.attached, entry.attached), '');
			return lines;
		}
		case 'assistant': {
			const lines: string[] = [];
			if (entry.reasoning) {
				lines.push(
					marker(MARK.thinking, { thoughtMs: entry.thoughtMs }),
					fenced(entry.reasoning.trim(), 'text'),
					'',
				);
			}
			// A tool-only turn has no prose, and a heading over nothing reads as a
			// mistake; its tool blocks follow and stand on their own.
			if (entry.text.trim()) lines.push(ASSISTANT_HEADING, '', entry.text.trim(), '');
			lines.push(...renderStats(entry.stats, entry.aborted));
			return lines;
		}
		case 'tool':
			return [
				marker(MARK.tool, { id: entry.call.id, name: entry.call.name }),
				`> 🔧 \`${entry.call.name}\``,
				'',
				fenced(entry.call.arguments.trim() || '{}', 'json'),
				fenced(entry.result, 'text'),
				'',
			];
		case 'change':
			return [
				marker(MARK.change, {
					path: entry.path,
					change: entry.change,
					added: entry.diff.added,
					removed: entry.diff.removed,
					truncated: entry.diff.truncated,
				}),
				`> ${entry.change === 'create' ? 'Created' : 'Updated'} [[${entry.path}]] · +${entry.diff.added} −${entry.diff.removed}`,
				'',
				fenced(entry.diff.body, 'diff'),
				'',
			];
		case 'approval':
			return [
				marker(MARK.approval, { request: entry.request, decision: entry.decision }),
				`> 🛡️ ${entry.request.tool} — ${describeDecision(entry.decision)}`,
				'',
			];
		case 'error':
			return [marker(MARK.error), `> ⚠️ ${entry.message}`, ''];
	}
}

/** The approval outcome in the words the card used. */
export function describeDecision(decision: ApprovalResult): string {
	switch (decision) {
		case 'deny':
			return 'denied';
		case 'once':
			return 'allowed once';
		case 'session':
			return 'allowed for the session';
		case 'always-file':
			return 'always allowed: this file';
		case 'always-folder':
			return 'always allowed: this folder';
		case 'always-trust':
			return 'server always trusted';
	}
}

/** Render entries as the body of a transcript note (no frontmatter). */
export function renderTranscript(entries: TranscriptEntry[]): string[] {
	const lines: string[] = [];
	for (const entry of entries) lines.push(...renderEntry(entry));
	return lines;
}

// --- Parsing -----------------------------------------------------------------

/**
 * Walks a transcript line by line, aware of fenced blocks.
 *
 * Fence awareness is the whole game: a tool result can be a note, a note can be
 * a saved conversation, and its "## 🧑 You" headings must stay text rather than
 * starting a turn here.
 */
class Reader {
	private i = 0;

	constructor(private lines: string[]) {}

	done(): boolean {
		return this.i >= this.lines.length;
	}

	peek(): string {
		return this.lines[this.i] ?? '';
	}

	next(): string {
		return this.lines[this.i++] ?? '';
	}

	/**
	 * Read the fenced block starting at the current line and return its body.
	 * Anything else returns null and consumes nothing, so a transcript that has
	 * been hand-edited degrades to missing detail rather than to a wrong parse.
	 */
	fencedBody(): string | null {
		const open = /^(`{3,}|~{3,})/.exec(this.peek().trim());
		if (!open) return null;
		const fence = open[1] ?? '';
		this.next();
		const body: string[] = [];
		while (!this.done()) {
			const line = this.next();
			if (line.trim().startsWith(fence) && !line.trim().slice(fence.length).trim()) {
				return body.join('\n');
			}
			body.push(line);
		}
		return body.join('\n');
	}

	/** Skip blank lines, so a caller can look for what follows a marker. */
	skipBlank(): void {
		while (!this.done() && !this.peek().trim()) this.next();
	}

	/**
	 * Prose up to the next heading, marker, or fenced block — collecting fenced
	 * blocks whole, so a code block inside an answer stays part of it.
	 *
	 * Inside an inlined note nothing is a marker. An attached note can be a saved
	 * conversation, and its own "## 🧑 You" headings are text that was quoted,
	 * not turns of this one: without this a single message carrying one splits
	 * into four.
	 */
	prose(): string {
		const out: string[] = [];
		const inlined = makeFenceTracker();
		while (!this.done()) {
			const line = this.peek();
			const trimmed = line.trim();
			if (inlined(line)) {
				out.push(this.next());
				continue;
			}
			if (markerKind(line)) break;
			if (trimmed === USER_HEADING || trimmed === ASSISTANT_HEADING) break;
			if (/^(`{3,}|~{3,})/.test(trimmed)) {
				const start = this.peek();
				const body = this.fencedBody();
				if (body === null) break;
				const fence = /^(`{3,}|~{3,})/.exec(start.trim())?.[1] ?? '```';
				out.push(start, body, fence);
				continue;
			}
			out.push(this.next());
		}
		return out.join('\n').trim();
	}
}

/** Strip a transcript's frontmatter, returning the body. */
function stripFrontmatter(md: string): string {
	if (!md.startsWith('---\n')) return md;
	const end = md.indexOf('\n---\n', 4);
	return end === -1 ? md : md.slice(end + 5);
}

/**
 * Read a saved transcript back into entries.
 *
 * Transcripts written before this format exist in people's vaults and stay
 * valid: their headings mean what they always did, and a turn that recorded
 * nothing more simply comes back with nothing more.
 */
export function parseTranscript(md: string): TranscriptEntry[] {
	const reader = new Reader(stripFrontmatter(md).split('\n'));
	const entries: TranscriptEntry[] = [];

	/** The assistant entry still open, so its stats and tools can reach it. */
	let pending: Extract<TranscriptEntry, { kind: 'assistant' }> | null = null;
	const closeAssistant = (): void => {
		pending = null;
	};

	while (!reader.done()) {
		const line = reader.peek();
		const trimmed = line.trim();

		if (!trimmed) {
			reader.next();
			continue;
		}

		if (trimmed === USER_HEADING) {
			reader.next();
			closeAssistant();
			// On the wire the typed message and the notes a [[link]] attached are
			// one string, and that is how they were written here. The bubble shows
			// only what was typed, so they come apart again at the fence.
			const { text, block } = splitInlined(reader.prose());
			entries.push(block ? { kind: 'user', text, block } : { kind: 'user', text });
			continue;
		}

		if (trimmed === ASSISTANT_HEADING) {
			reader.next();
			const text = reader.prose();
			// Reasoning is written before the heading, so an entry may already be
			// open waiting for its prose.
			if (pending && !pending.text) pending.text = text;
			else {
				pending = { kind: 'assistant', text };
				entries.push(pending);
			}
			continue;
		}

		const kind = markerKind(line);
		if (!kind) {
			// Loose prose: either an old transcript's tool line, or hand-written
			// text. Attach it to whatever turn is open rather than losing it.
			const text = reader.prose();
			if (!text) {
				reader.next();
				continue;
			}
			const last = entries[entries.length - 1];
			if (last?.kind === 'user') {
				const merged = splitInlined(`${last.text}${last.block ?? ''}\n\n${text}`.trim());
				last.text = merged.text;
				if (merged.block) last.block = merged.block;
			}
			continue;
		}

		reader.next();
		switch (kind) {
			case MARK.attached: {
				const data = readMarker(line, MARK.attached) as ExpansionSummary | null;
				const last = entries[entries.length - 1];
				if (data && last?.kind === 'user') last.attached = data;
				break;
			}
			case MARK.thinking: {
				const data = readMarker(line, MARK.thinking) as { thoughtMs?: number } | null;
				reader.skipBlank();
				const reasoning = reader.fencedBody() ?? '';
				pending = { kind: 'assistant', text: '', reasoning, thoughtMs: data?.thoughtMs };
				entries.push(pending);
				break;
			}
			case MARK.tool: {
				const data = readMarker(line, MARK.tool) as { id?: string; name?: string } | null;
				reader.skipBlank();
				// The visible "> 🔧 name" line sits between the marker and the args.
				if (reader.peek().trim().startsWith('>')) reader.next();
				reader.skipBlank();
				const args = reader.fencedBody() ?? '{}';
				reader.skipBlank();
				const result = reader.fencedBody() ?? '';
				entries.push({
					kind: 'tool',
					call: { id: data?.id ?? '', name: data?.name ?? 'tool', arguments: args },
					result,
				});
				closeAssistant();
				break;
			}
			case MARK.change: {
				const data = readMarker(line, MARK.change) as {
					path?: string;
					change?: 'create' | 'update';
					added?: number;
					removed?: number;
					truncated?: boolean;
				} | null;
				reader.skipBlank();
				if (reader.peek().trim().startsWith('>')) reader.next();
				reader.skipBlank();
				const body = reader.fencedBody() ?? '';
				entries.push({
					kind: 'change',
					path: data?.path ?? '',
					change: data?.change === 'create' ? 'create' : 'update',
					diff: {
						body,
						added: data?.added ?? 0,
						removed: data?.removed ?? 0,
						truncated: data?.truncated === true,
					},
				});
				break;
			}
			case MARK.approval: {
				const data = readMarker(line, MARK.approval) as {
					request?: ApprovalRequest;
					decision?: ApprovalResult;
				} | null;
				if (data?.request && data.decision) {
					entries.push({ kind: 'approval', request: data.request, decision: data.decision });
				}
				reader.skipBlank();
				if (reader.peek().trim().startsWith('>')) reader.next();
				break;
			}
			case MARK.error: {
				reader.skipBlank();
				const text = reader.peek().trim();
				if (text.startsWith('>')) {
					reader.next();
					entries.push({ kind: 'error', message: text.replace(/^>\s*⚠️\s*/, '').trim() });
				}
				break;
			}
			case MARK.stats: {
				const data = readMarker(line, MARK.stats) as {
					stats?: TurnStats;
					aborted?: boolean;
				} | null;
				if (pending && data) {
					pending.stats = data.stats;
					pending.aborted = data.aborted;
				}
				reader.skipBlank();
				// The italic line that repeats the marker for a human reader.
				if (/^\*.*\*$/.test(reader.peek().trim())) reader.next();
				break;
			}
		}
	}

	return entries;
}

// --- Projection to the wire ---------------------------------------------------

/**
 * The message list the endpoint receives, derived from the record.
 *
 * Reasoning is dropped here and nowhere else: a model's thinking is shown and
 * stored but never sent back, and one projection is the only place that has to
 * remember it. Panel-only entries — diffs, approvals, errors — never had a
 * place in the wire format and are simply not projected.
 *
 * Tool entries attach to the assistant turn above them, which is the order the
 * agent loop produces and the panel shows. Tool entries with no assistant turn
 * open get an empty one, because the schema requires every tool result to
 * answer a call on an assistant message.
 */
export function toMessages(entries: TranscriptEntry[]): ChatMessage[] {
	const messages: ChatMessage[] = [];
	let assistant: ChatMessage | null = null;
	let results: ChatMessage[] = [];

	/**
	 * Emit one assistant turn with its tool results.
	 *
	 * A turn recorded mid-flight — a conversation saved while the agent was
	 * still working, or stopped between a call and its result — can hold a call
	 * nobody answered. The schema requires every call to be answered and every
	 * result to answer a call, so the unmatched halves are dropped on both
	 * sides. The prose is kept: it is what the model said, and it is still true.
	 */
	const flush = (): void => {
		if (assistant) {
			const answered = new Set(results.map((r) => r.toolCallId ?? ''));
			const calls = (assistant.toolCalls ?? []).filter((c) => answered.has(c.id));
			const wanted = new Set<string>(calls.map((c) => c.id));
			assistant.toolCalls = calls.length ? calls : undefined;
			if (assistant.content || calls.length) messages.push(assistant);
			messages.push(...results.filter((r) => wanted.has(r.toolCallId ?? '')));
		}
		assistant = null;
		results = [];
	};

	for (const entry of entries) {
		switch (entry.kind) {
			case 'user':
				flush();
				messages.push({ role: 'user', content: entry.text + (entry.block ?? '') });
				break;
			case 'assistant':
				flush();
				assistant = { role: 'assistant', content: entry.text };
				break;
			case 'tool': {
				if (!assistant) assistant = { role: 'assistant', content: '' };
				assistant.toolCalls = [...(assistant.toolCalls ?? []), entry.call];
				results.push({ role: 'tool', toolCallId: entry.call.id, content: entry.result });
				break;
			}
			default:
				break;
		}
	}
	flush();
	return messages;
}

/**
 * Messages as transcript entries — the inverse of {@link toMessages} for the
 * plain case. Used by the conversation importer, whose sources give it what was
 * said and nothing else: there were no tools, diffs or approvals to record.
 */
export function fromMessages(messages: ChatMessage[]): TranscriptEntry[] {
	const entries: TranscriptEntry[] = [];
	for (const m of messages) {
		if (m.role === 'user') entries.push({ kind: 'user', text: m.content });
		else if (m.role === 'assistant' && m.content) {
			entries.push({ kind: 'assistant', text: m.content });
		}
	}
	return entries;
}

/** Serialise a drawn diff for storage: the lines that were shown, as text. */
export function serializeDiff(diff: {
	hunks: { lines: { kind: string; text: string }[]; gapBefore: boolean }[];
	added: number;
	removed: number;
	truncated: boolean;
}): SerializedDiff {
	const out: string[] = [];
	for (const hunk of diff.hunks) {
		if (hunk.gapBefore) out.push('⋯');
		for (const line of hunk.lines) {
			const mark = line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' ';
			out.push(`${mark}${line.text}`);
		}
	}
	return { body: out.join('\n'), added: diff.added, removed: diff.removed, truncated: diff.truncated };
}
