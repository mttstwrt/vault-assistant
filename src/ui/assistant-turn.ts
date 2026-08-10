/**
 * One assistant turn as it streams in: text appears as it is generated, the
 * model's reasoning goes into a collapsible "thinking" section that ticks while
 * it works, and the finished answer is re-rendered as markdown.
 */
import { App, Component, MarkdownRenderer, setIcon } from 'obsidian';
import { CallStats } from '../api/client';
import { addCopyButton } from './message-render';

export interface TurnOptions {
	/** Keep the thinking section open while the model reasons. */
	expandThinking: boolean;
	/** Called whenever the turn grows, so the panel can follow along. */
	onGrow: () => void;
}

/** The live thinking section, created the first time reasoning arrives. */
interface ThinkBlock {
	details: HTMLDetailsElement;
	label: HTMLElement;
	text: Text;
	startedAt: number;
	/** 0 while the model is still reasoning. */
	endedAt: number;
	/** Once the user opens or closes it themselves, we stop doing it for them. */
	userToggled: boolean;
}

export class AssistantTurn {
	private bubble: HTMLElement | null = null;
	private contentEl: HTMLElement | null = null;
	private contentText: Text | null = null;
	private think: ThinkBlock | null = null;
	private ticker: number | null = null;
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
		this.closeThinking();
		// Reasoning models leave blank lines behind their closing tag.
		const text = this.content ? delta : delta.replace(/^\s+/, '');
		if (!text) return;
		this.content += text;
		this.ensureContent().appendData(text);
		this.opts.onGrow();
	}

	pushReasoning(delta: string): void {
		this.reasoning += delta;
		const think = this.ensureThink();
		// A model that reasons again after answering restarts the clock.
		if (think.endedAt) {
			think.endedAt = 0;
			think.startedAt = Date.now();
			this.startTicker();
		}
		think.text.appendData(delta);
		this.updateThinkLabel();
		this.opts.onGrow();
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
		const think = this.ensureThink();
		think.text.data = this.reasoning;
		this.updateThinkLabel();
	}

	/** Close the turn: render the answer as markdown and report how it went. */
	async finish(info: { stats?: CallStats; aborted: boolean }): Promise<void> {
		this.stopTicker();
		this.closeThinking();

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
		this.stopTicker();
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

	private ensureThink(): ThinkBlock {
		if (this.think) return this.think;
		const bubble = this.ensureBubble();
		const details = bubble.createEl('details', { cls: 'va-think' });
		// The thinking section belongs above the answer it produced.
		if (this.contentEl) bubble.insertBefore(details, this.contentEl);
		details.open = this.opts.expandThinking;

		const summary = details.createEl('summary');
		setIcon(summary.createSpan({ cls: 'va-think-icon' }), 'brain');
		const label = summary.createSpan({ cls: 'va-think-label', text: 'Thinking…' });

		const body = details.createDiv({ cls: 'va-think-body' });
		const text = body.doc.createTextNode('');
		body.appendChild(text);

		this.think = {
			details,
			label,
			text,
			startedAt: Date.now(),
			endedAt: 0,
			userToggled: false,
		};
		// Clicking (or keying) the summary is the only signal of user intent we
		// can trust: setting `open` in code fires `toggle` too.
		summary.addEventListener('click', () => {
			if (this.think) this.think.userToggled = true;
		});
		this.startTicker();
		return this.think;
	}

	/** Mark reasoning as finished: freeze the clock and fold the section away. */
	private closeThinking(): void {
		const think = this.think;
		if (!think || think.endedAt) return;
		think.endedAt = Date.now();
		this.stopTicker();
		this.updateThinkLabel();
		if (!think.userToggled) think.details.open = false;
	}

	private updateThinkLabel(): void {
		const think = this.think;
		if (!think) return;
		const seconds = ((think.endedAt || Date.now()) - think.startedAt) / 1000;
		think.label.setText(
			think.endedAt ? `Thought for ${seconds.toFixed(1)}s` : `Thinking… ${seconds.toFixed(1)}s`,
		);
	}

	private startTicker(): void {
		if (this.ticker !== null) return;
		this.ticker = this.parent.win.setInterval(() => this.updateThinkLabel(), 200);
	}

	private stopTicker(): void {
		if (this.ticker === null) return;
		this.parent.win.clearInterval(this.ticker);
		this.ticker = null;
	}
}
