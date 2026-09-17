/** Rendering helpers shared by the chat panel and its streaming turns. */
import { App, Component, MarkdownRenderer, Notice, TFile, setIcon } from 'obsidian';
import { TurnStats } from '../types';
import {
	ApprovalRequest,
	ApprovalResult,
	ExpansionSummary,
	SerializedDiff,
	ToolCall,
	TranscriptEntry,
} from '../types';
import { describeDecision } from '../transcript';

/**
 * A vault path as an Obsidian internal link.
 *
 * The panel already delegates clicks and hover previews for `a.internal-link`
 * inside the message list (see ChatView.onOpen) — that is how a [[link]] inside
 * a rendered answer opens its note. Every other path the panel prints is the
 * same thing, written by us instead of by MarkdownRenderer, so it gets the same
 * markup instead of being dead text to retype into the quick switcher.
 *
 * A path with no note behind it stays plain text: clicking an internal link to
 * a file that does not exist offers to create it, which is not what a record of
 * what just happened should do.
 */
export function createPathLink(
	app: App,
	parent: HTMLElement,
	path: string,
	label = path,
): HTMLElement {
	const file = path.split('#')[0] ?? path;
	if (!(app.vault.getAbstractFileByPath(file) instanceof TFile)) {
		return parent.createSpan({ cls: 'va-path', text: label });
	}
	return parent.createEl('a', {
		cls: 'internal-link va-path',
		text: label,
		attr: { href: path, 'data-href': path },
	});
}

/**
 * What the endpoint reported about one turn, as the line under an answer.
 * Shared by streamed and buffered turns so the two report alike — an endpoint
 * that volunteers timings says the same thing whichever way it was called.
 * Empty when there is nothing to report.
 */
export function statsFooter(info: { stats?: TurnStats; aborted: boolean }): string {
	const parts: string[] = [];
	if (info.aborted) parts.push('Stopped');
	const s = info.stats;
	if (s) {
		parts.push(`${(s.elapsedMs / 1000).toFixed(1)}s`);
		if (s.completionTokens) parts.push(`${s.completionTokens} tokens`);
		if (s.tokensPerSecond) parts.push(`${s.tokensPerSecond.toFixed(1)} tok/s`);
	}
	return parts.join(' · ');
}

/** Add the stats line to a finished bubble, when there is anything to say. */
export function addStats(bubble: HTMLElement, info: { stats?: TurnStats; aborted: boolean }): void {
	const text = statsFooter(info);
	if (text) bubble.createDiv({ cls: 'va-stats', text });
}

/** Pretty-print a JSON string for display, falling back to the raw text. */
export function prettyJson(raw: string): string {
	try {
		return JSON.stringify(JSON.parse(raw), null, 2);
	} catch {
		return raw;
	}
}

export function addInfo(parent: HTMLElement, text: string): HTMLElement {
	return parent.createDiv({ cls: 'va-info', text });
}

export function addError(parent: HTMLElement, message: string): HTMLElement {
	return parent.createDiv({ cls: 'va-error', text: `⚠️ ${message}` });
}

/** A "copy this message" button, which flashes a checkmark on success. */
export function addCopyButton(parent: HTMLElement, getText: () => string): HTMLButtonElement {
	const btn = parent.createEl('button', {
		cls: 'va-copy',
		attr: { 'aria-label': 'Copy message' },
	});
	setIcon(btn, 'copy');
	btn.onclick = () => {
		void navigator.clipboard
			.writeText(getText())
			.then(() => {
				setIcon(btn, 'check');
				btn.win.setTimeout(() => setIcon(btn, 'copy'), 1200);
			})
			.catch(() => new Notice('Could not copy to the clipboard.'));
	};
	return btn;
}

/** A message bubble with its role label and copy button. */
function createBubble(
	parent: HTMLElement,
	role: 'user' | 'assistant',
	getText: () => string,
): { bubble: HTMLElement; content: HTMLElement } {
	const bubble = parent.createDiv({ cls: `va-msg va-${role}` });
	const head = bubble.createDiv({ cls: 'va-msg-head' });
	head.createDiv({ cls: 'va-role', text: role === 'user' ? 'You' : 'Assistant' });
	addCopyButton(head, getText);
	return { bubble, content: bubble.createDiv({ cls: 'va-content' }) };
}

export function addUserBubble(parent: HTMLElement, text: string): HTMLElement {
	const { bubble, content } = createBubble(parent, 'user', () => text);
	content.setText(text);
	return bubble;
}

/**
 * What the [[link]] expander attached to a message, under the bubble that sent
 * it. Pulling a note into a message without showing it would be the plugin
 * quietly sending vault contents the user did not watch it send — so every
 * note named here is a link to the note itself, and checking what was sent is
 * a click rather than a search.
 */
export function addExpansionNote(app: App, bubble: HTMLElement, e: ExpansionSummary): void {
	if (!e.inlined.length && !e.missed.length && !e.blocked && !e.deferred.length) return;
	const note = bubble.createDiv({ cls: 'va-inlined' });
	const row = (): HTMLElement => {
		const line = note.createDiv();
		line.appendText('↘ ');
		return line;
	};

	if (e.inlined.length) {
		const chars = e.inlined.reduce((n, i) => n + i.chars, 0);
		const line = row();
		line.appendText('inlined ');
		e.inlined.forEach((i, n) => {
			if (n) line.appendText(' · ');
			createPathLink(app, line, `${i.path}${i.subpath}`);
		});
		line.appendText(` (${(chars / 1000).toFixed(1)}k)`);
	}

	for (const m of e.missed) {
		const line = row();
		line.appendText(`[[${m.link}]] matched no note`);
		if (m.near) {
			line.appendText(' — did you mean ');
			createPathLink(app, line, m.near);
			line.appendText('?');
		}
	}

	if (e.blocked) {
		row().appendText(
			e.blocked === 1
				? '1 link is in a blocked folder — not attached'
				: `${e.blocked} links are in blocked folders — not attached`,
		);
	}

	if (e.deferred.length) {
		row().appendText(`${e.deferred.length} more linked, not attached (message budget)`);
	}
}

/** An assistant turn as the record holds it: thinking, answer, and what it cost. */
export type AssistantEntry = Extract<TranscriptEntry, { kind: 'assistant' }>;

/**
 * A finished assistant turn — the one renderer for every turn the panel did not
 * stream itself: a buffered answer, and every turn of a reopened conversation.
 * Streaming builds the same shape incrementally in ./assistant-turn.
 */
export async function addAssistantTurn(
	app: App,
	component: Component,
	parent: HTMLElement,
	entry: AssistantEntry,
): Promise<HTMLElement> {
	const { bubble, content } = createBubble(parent, 'assistant', () => entry.text);
	if (entry.reasoning) {
		const think = bubble.createEl('details', { cls: 'va-think' });
		const summary = think.createEl('summary');
		setIcon(summary.createSpan({ cls: 'va-think-icon' }), 'brain');
		summary.createSpan({
			cls: 'va-think-label',
			text: entry.thoughtMs
				? `Thought for ${(entry.thoughtMs / 1000).toFixed(1)}s`
				: 'Thinking',
		});
		think.createDiv({ cls: 'va-think-body', text: entry.reasoning });
		// The thinking section belongs above the answer it produced.
		bubble.insertBefore(think, content);
	}
	if (entry.text) await MarkdownRenderer.render(app, entry.text, content, '', component);
	addStats(bubble, { stats: entry.stats, aborted: entry.aborted === true });
	return bubble;
}

/**
 * An approval that has already been answered, as a reopened conversation shows
 * it. The live card is interactive and becomes this once it settles; here there
 * is nothing left to decide, only the record of what was decided.
 */
export function addApprovalRecord(
	app: App,
	parent: HTMLElement,
	request: ApprovalRequest,
	decision: ApprovalResult,
): HTMLElement {
	const card = parent.createDiv({ cls: 'va-approval va-approval-done' });
	const head = card.createDiv({ cls: 'va-approval-head' });
	setIcon(head.createSpan({ cls: 'va-approval-icon' }), 'shield-alert');
	head.createSpan({ text: request.kind === 'mcp' ? ' External tool call' : ' Approval required' });
	card.createDiv({ cls: 'va-approval-body', text: `via ${request.tool}` });
	if (request.path) {
		const line = card.createEl('code', { cls: 'va-approval-path' });
		createPathLink(app, line, request.path);
		if (request.toPath) {
			line.appendText('  →  ');
			createPathLink(app, line, request.toPath);
		}
	}
	card.createDiv({ cls: 'va-approval-choice', text: `→ ${describeDecision(decision)}` });
	return card;
}

export function addToolCall(parent: HTMLElement, call: ToolCall): HTMLElement {
	const details = parent.createEl('details', { cls: 'va-tool' });
	const summary = details.createEl('summary');
	setIcon(summary.createSpan({ cls: 'va-tool-icon' }), 'wrench');
	summary.createSpan({ text: ` ${call.name}` });
	details.createEl('pre', { cls: 'va-tool-args', text: prettyJson(call.arguments) });
	return details;
}

/** A write, as the transcript records it. */
export type ChangeEntry = Extract<TranscriptEntry, { kind: 'change' }>;

/** "Updated <path>", with the path as a link to the note it names. */
function setChangeLabel(app: App, label: HTMLElement, change: ChangeEntry): void {
	label.empty();
	label.appendText(`${change.change === 'create' ? 'Created' : 'Updated'} `);
	createPathLink(app, label, change.path);
}

/** Changed lines beyond this are summarised rather than drawn. */
const MAX_DIFF_ROWS = 400;
/** A change this small is worth showing without a click. */
const OPEN_BELOW = 24;

/** "+12 −3", coloured, for a diff's header. */
function renderCounts(parent: HTMLElement, diff: SerializedDiff): void {
	const counts = parent.createSpan({ cls: 'va-change-counts' });
	if (diff.added) counts.createSpan({ cls: 'va-diff-add-text', text: `+${diff.added}` });
	if (diff.removed) counts.createSpan({ cls: 'va-diff-del-text', text: `−${diff.removed}` });
}

/**
 * Draw the diff: its own lines decide their colour, by the "+", "-" and "⋯"
 * prefixes a unified diff already carries. Reading the marks back rather than
 * keeping a parallel structure is what lets a reopened conversation draw the
 * same card as the live one, from the text the transcript kept.
 */
function renderDiffBody(parent: HTMLElement, diff: SerializedDiff): void {
	const body = parent.createDiv({ cls: 'va-diff' });
	if (diff.truncated) {
		body.createDiv({
			cls: 'va-diff-note',
			text: `Too large to diff: ${diff.removed} lines replaced by ${diff.added}.`,
		});
		return;
	}

	let drawn = 0;
	for (const line of diff.body ? diff.body.split('\n') : []) {
		if (drawn >= MAX_DIFF_ROWS) break;
		if (line === '⋯') {
			body.createDiv({ cls: 'va-diff-gap', text: '⋯' });
			continue;
		}
		drawn++;
		const mark = line[0];
		const cls =
			mark === '+' ? 'va-diff-add' : mark === '-' ? 'va-diff-del' : 'va-diff-ctx';
		body.createDiv({ cls: `va-diff-line ${cls}`, text: line });
	}
	if (drawn >= MAX_DIFF_ROWS) {
		body.createDiv({ cls: 'va-diff-note', text: '…rest of the diff not shown.' });
	}
}

/**
 * A write, shown as a diff: green additions, red removals, a little context.
 * Small changes are expanded; larger ones collapse behind their line counts.
 */
export function addFileChange(app: App, parent: HTMLElement, change: ChangeEntry): HTMLElement {
	const { diff } = change;
	const card = parent.createEl('details', { cls: 'va-change' });
	card.open = !diff.truncated && diff.added + diff.removed <= OPEN_BELOW;

	const summary = card.createEl('summary');
	setIcon(
		summary.createSpan({ cls: 'va-change-icon' }),
		change.change === 'create' ? 'file-plus' : 'file-pen',
	);
	setChangeLabel(app, summary.createSpan({ cls: 'va-change-path' }), change);
	renderCounts(summary, diff);
	renderDiffBody(card, diff);
	return card;
}

/**
 * The same diff, for a write that hasn't happened yet: what the approval card
 * is actually asking you to allow.
 */
export function addDiffPreview(
	parent: HTMLElement,
	diff: SerializedDiff,
	creating: boolean,
): HTMLElement {
	const card = parent.createEl('details', { cls: 'va-change va-change-preview' });
	card.open = !diff.truncated && diff.added + diff.removed <= OPEN_BELOW;

	const summary = card.createEl('summary');
	setIcon(summary.createSpan({ cls: 'va-change-icon' }), creating ? 'file-plus' : 'file-pen');
	summary.createSpan({
		cls: 'va-change-path',
		text: creating ? 'What it would write' : 'What it would change',
	});
	renderCounts(summary, diff);
	renderDiffBody(card, diff);
	return card;
}

/**
 * Relabel an approved preview as the write that followed, so the card you said
 * yes to becomes the record of what happened — rather than drawing the same
 * diff twice.
 */
export function markPreviewApplied(app: App, card: HTMLElement, change: ChangeEntry): void {
	const label = card.querySelector('.va-change-path');
	if (label instanceof HTMLElement) setChangeLabel(app, label, change);
	card.removeClass('va-change-preview');
}

export function addToolResult(details: HTMLElement, result: string): void {
	const trimmed = result.length > 2000 ? result.slice(0, 2000) + '\n…(truncated)' : result;
	details.createEl('pre', { cls: 'va-tool-result', text: trimmed });
}
