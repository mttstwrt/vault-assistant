/** Rendering helpers shared by the chat panel and its streaming turns. */
import { App, Component, MarkdownRenderer, Notice, setIcon } from 'obsidian';
import { FileChange, ToolCall } from '../types';
import { FileDiff, diffLines } from './diff';

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
export function createBubble(
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
 * quietly sending vault contents the user did not watch it send.
 */
export function addInlinedNote(bubble: HTMLElement, lines: string[]): void {
	if (!lines.length) return;
	const note = bubble.createDiv({ cls: 'va-inlined' });
	for (const line of lines) note.createDiv({ text: `↘ ${line}` });
}

/** A finished assistant message, rendered as markdown (saved transcripts, non-streamed turns). */
export async function addAssistantBubble(
	app: App,
	component: Component,
	parent: HTMLElement,
	markdown: string,
): Promise<HTMLElement> {
	const { bubble, content } = createBubble(parent, 'assistant', () => markdown);
	await MarkdownRenderer.render(app, markdown, content, '', component);
	return bubble;
}

export function addToolCall(parent: HTMLElement, call: ToolCall): HTMLElement {
	const details = parent.createEl('details', { cls: 'va-tool' });
	const summary = details.createEl('summary');
	setIcon(summary.createSpan({ cls: 'va-tool-icon' }), 'wrench');
	summary.createSpan({ text: ` ${call.name}` });
	details.createEl('pre', { cls: 'va-tool-args', text: prettyJson(call.arguments) });
	return details;
}

/** Changed lines beyond this are summarised rather than drawn. */
const MAX_DIFF_ROWS = 400;
/** A change this small is worth showing without a click. */
const OPEN_BELOW = 24;

/** "+12 −3", coloured, for a diff's header. */
function renderCounts(parent: HTMLElement, diff: FileDiff): void {
	const counts = parent.createSpan({ cls: 'va-change-counts' });
	if (diff.added) counts.createSpan({ cls: 'va-diff-add-text', text: `+${diff.added}` });
	if (diff.removed) counts.createSpan({ cls: 'va-diff-del-text', text: `−${diff.removed}` });
}

/** Draw the diff itself: hunks, the gaps between them, and the caps. */
function renderDiffBody(parent: HTMLElement, diff: FileDiff): void {
	const body = parent.createDiv({ cls: 'va-diff' });
	if (diff.truncated) {
		body.createDiv({
			cls: 'va-diff-note',
			text: `Too large to diff: ${diff.removed} lines replaced by ${diff.added}.`,
		});
		return;
	}

	let drawn = 0;
	for (const hunk of diff.hunks) {
		if (drawn >= MAX_DIFF_ROWS) break;
		if (hunk.gapBefore) body.createDiv({ cls: 'va-diff-gap', text: '⋯' });
		for (const line of hunk.lines) {
			if (drawn++ >= MAX_DIFF_ROWS) break;
			const cls =
				line.kind === 'add' ? 'va-diff-add' : line.kind === 'remove' ? 'va-diff-del' : 'va-diff-ctx';
			const mark = line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' ';
			body.createDiv({ cls: `va-diff-line ${cls}`, text: `${mark}${line.text}` });
		}
	}
	if (drawn >= MAX_DIFF_ROWS) {
		body.createDiv({ cls: 'va-diff-note', text: '…rest of the diff not shown.' });
	}
}

/**
 * A write, shown as a diff: green additions, red removals, a little context.
 * Small changes are expanded; larger ones collapse behind their line counts.
 */
export function addFileChange(parent: HTMLElement, change: FileChange): HTMLElement {
	const diff = diffLines(change.before, change.after);
	const card = parent.createEl('details', { cls: 'va-change' });
	card.open = !diff.truncated && diff.added + diff.removed <= OPEN_BELOW;

	const summary = card.createEl('summary');
	setIcon(
		summary.createSpan({ cls: 'va-change-icon' }),
		change.kind === 'create' ? 'file-plus' : 'file-pen',
	);
	summary.createSpan({
		cls: 'va-change-path',
		text: `${change.kind === 'create' ? 'Created' : 'Updated'} ${change.path}`,
	});
	renderCounts(summary, diff);
	renderDiffBody(card, diff);
	return card;
}

/**
 * The same diff, for a write that hasn't happened yet: what the approval card
 * is actually asking you to allow.
 */
export function addDiffPreview(parent: HTMLElement, before: string, after: string): HTMLElement {
	const diff = diffLines(before, after);
	const card = parent.createEl('details', { cls: 'va-change va-change-preview' });
	card.open = !diff.truncated && diff.added + diff.removed <= OPEN_BELOW;

	const summary = card.createEl('summary');
	setIcon(summary.createSpan({ cls: 'va-change-icon' }), before ? 'file-pen' : 'file-plus');
	summary.createSpan({
		cls: 'va-change-path',
		text: before ? 'What it would change' : 'What it would write',
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
export function markPreviewApplied(card: HTMLElement, change: FileChange): void {
	const label = card.querySelector('.va-change-path');
	if (label instanceof HTMLElement) {
		label.setText(`${change.kind === 'create' ? 'Created' : 'Updated'} ${change.path}`);
	}
	card.removeClass('va-change-preview');
}

export function addToolResult(details: HTMLElement, result: string): void {
	const trimmed = result.length > 2000 ? result.slice(0, 2000) + '\n…(truncated)' : result;
	details.createEl('pre', { cls: 'va-tool-result', text: trimmed });
}
