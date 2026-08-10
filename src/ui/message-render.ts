/** Rendering helpers shared by the chat panel and its streaming turns. */
import { App, Component, MarkdownRenderer, Notice, setIcon } from 'obsidian';
import { ToolCall } from '../types';

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

export function addToolResult(details: HTMLElement, result: string): void {
	const trimmed = result.length > 2000 ? result.slice(0, 2000) + '\n…(truncated)' : result;
	details.createEl('pre', { cls: 'va-tool-result', text: trimmed });
}
