/**
 * One assistant turn as it streams in: text appears as it is generated, the
 * model's reasoning goes into a collapsible "thinking" section that ticks while
 * it works, and the finished answer is re-rendered as markdown.
 */
import { App, Component, MarkdownRenderer } from 'obsidian';
import { CallStats } from '../api/client';
import { addCopyButton } from './message-render';
import { ThinkingSection } from './thinking';

export interface TurnOptions {
	/** Keep the thinking section open while the model reasons. */
	expandThinking: boolean;
	/** Called whenever the turn grows, so the panel can follow along. */
	onGrow: () => void;
}

export class AssistantTurn {
	private bubble: HTMLElement | null = null;
	private contentEl: HTMLElement | null = null;
	private contentText: Text | null = null;
	private think: ThinkingSection | null = null;
	private content = '';
	private reasoning = '';

	constructor(
		private app: App,
		private component: Component,
		private parent: HTMLElement,
		private opts: TurnOptions,
	) {}

	/** Answer text; appended to a single text node so selections survive. */
	pushContent(delta: string): void {
		this.think?.close();
		// Reasoning models leave blank lines behind their closing tag.
		const text = this.content ? delta : delta.replace(/^\s+/, '');
		if (!text) return;
		this.content += text;
		this.ensureContent().appendData(text);
		this.opts.onGrow();
	}

	pushReasoning(delta: string): void {
		this.reasoning += delta;
		this.ensureThink().push(delta);
	}

	/**
	 * The turn was reasoning from its first token (a closing `</think>` arrived
	 * with no opener), so move what we showed as the answer into the thinking
	 * section.
	 */
	reclassifyAsReasoning(): void {
		if (!this.content) return;
		const prior = this.content;
		this.content = '';
		if (this.contentText) this.contentText.data = '';
		this.reasoning = prior + this.reasoning;
		this.ensureThink().setText(this.reasoning);
	}

	/** Close the turn: render the answer as markdown and report how it went. */
	async finish(info: { stats?: CallStats; aborted: boolean }): Promise<void> {
		this.think?.close();

		if (!this.content.trim() && !this.reasoning.trim()) {
			// A tool-only turn has nothing to show.
			this.bubble?.remove();
			this.bubble = null;
			return;
		}

		if (this.contentEl && this.content) {
			this.contentEl.removeClass('va-streaming');
			this.contentEl.empty();
			try {
				await MarkdownRenderer.render(this.app, this.content, this.contentEl, '', this.component);
			} catch (e) {
				console.warn('[vault-assistant] Could not render the answer as markdown:', e);
				this.contentEl.setText(this.content);
			}
		}

		const footer = this.statusLine(info);
		if (footer && this.bubble) this.bubble.createDiv({ cls: 'va-stats', text: footer });
		this.opts.onGrow();
	}

	/** Whether anything was received — a tool-only turn shows nothing. */
	hasOutput(): boolean {
		return !!(this.content.trim() || this.reasoning.trim());
	}

	/** Stop the elapsed-time ticker (the view is closing mid-stream). */
	dispose(): void {
		this.think?.dispose();
	}

	private statusLine(info: { stats?: CallStats; aborted: boolean }): string {
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

	private ensureBubble(): HTMLElement {
		if (!this.bubble) {
			this.bubble = this.parent.createDiv({ cls: 'va-msg va-assistant' });
			const head = this.bubble.createDiv({ cls: 'va-msg-head' });
			head.createDiv({ cls: 'va-role', text: 'Assistant' });
			addCopyButton(head, () => this.content);
		}
		return this.bubble;
	}

	private ensureContent(): Text {
		if (!this.contentText) {
			this.contentEl = this.ensureBubble().createDiv({ cls: 'va-content va-streaming' });
			this.contentText = this.contentEl.doc.createTextNode('');
			this.contentEl.appendChild(this.contentText);
		}
		return this.contentText;
	}

	private ensureThink(): ThinkingSection {
		if (this.think) return this.think;
		const bubble = this.ensureBubble();
		this.think = new ThinkingSection(bubble, {
			expanded: this.opts.expandThinking,
			icon: 'brain',
			busyLabel: 'Thinking…',
			doneLabel: 'Thought for',
			onGrow: this.opts.onGrow,
		});
		// The thinking section belongs above the answer it produced.
		if (this.contentEl) bubble.insertBefore(this.think.el, this.contentEl);
		return this.think;
	}
}
