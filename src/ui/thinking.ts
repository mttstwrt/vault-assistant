/**
 * The collapsible "thinking" section: a details block that streams text in
 * while something is working and folds itself away with the time it took.
 *
 * Two things reason where the user can see it — the answer itself, and the
 * pre-pass that turns a question into vault searches before the answer starts.
 * They differ only in what the label says and which icon sits on it, so the
 * block itself lives here rather than twice.
 */
import { setIcon } from 'obsidian';

export interface ThinkingOptions {
	/** Open while it runs. It folds away when it ends either way. */
	expanded: boolean;
	/** Obsidian icon id for the summary. */
	icon: string;
	/** Shown while it runs, with the elapsed time appended. */
	busyLabel: string;
	/** Shown once it ends, with the elapsed time appended. */
	doneLabel: string;
	/** Called whenever the section grows, so the panel can follow along. */
	onGrow: () => void;
}

export class ThinkingSection {
	/** The details element, so a caller can move it within its own bubble. */
	readonly el: HTMLDetailsElement;
	private labelEl: HTMLElement;
	private textNode: Text;
	private notes = 0;
	private startedAt = Date.now();
	/** 0 while it is still running. */
	private endedAt = 0;
	/** Once the user opens or closes it themselves, we stop doing it for them. */
	private userToggled = false;
	private ticker: number | null = null;

	constructor(
		parent: HTMLElement,
		private opts: ThinkingOptions,
	) {
		this.el = parent.createEl('details', { cls: 'va-think' });
		this.el.open = opts.expanded;

		const summary = this.el.createEl('summary');
		setIcon(summary.createSpan({ cls: 'va-think-icon' }), opts.icon);
		this.labelEl = summary.createSpan({ cls: 'va-think-label', text: opts.busyLabel });

		const body = this.el.createDiv({ cls: 'va-think-body' });
		this.textNode = body.doc.createTextNode('');
		body.appendChild(this.textNode);

		// Clicking (or keying) the summary is the only signal of user intent we
		// can trust: setting `open` in code fires `toggle` too.
		summary.addEventListener('click', () => {
			this.userToggled = true;
		});
		this.startTicker();
	}

	/** Append reasoning as it arrives. */
	push(delta: string): void {
		// Reasoning that resumes after the section closed restarts the clock.
		if (this.endedAt) {
			this.endedAt = 0;
			this.startedAt = Date.now();
			this.startTicker();
		}
		this.textNode.appendData(delta);
		this.updateLabel();
		this.opts.onGrow();
	}

	/** Replace everything shown so far (reasoning arrived out of order). */
	setText(text: string): void {
		this.textNode.data = text;
		this.updateLabel();
		this.opts.onGrow();
	}

	/**
	 * Add a line under the reasoning — what the step settled on, as opposed to
	 * how it got there.
	 */
	addNote(text: string): void {
		this.notes++;
		this.el.createDiv({ cls: 'va-think-note', text });
		this.opts.onGrow();
	}

	/** Freeze the clock and fold the section away. */
	close(): void {
		if (this.endedAt) return;
		this.endedAt = Date.now();
		this.stopTicker();
		this.updateLabel();
		if (!this.userToggled) this.el.open = false;
	}

	/** Whether anything was shown — a section with nothing in it is noise. */
	isEmpty(): boolean {
		return !this.textNode.data.trim() && this.notes === 0;
	}

	/** Take the section back out of the stream. */
	remove(): void {
		this.stopTicker();
		this.el.remove();
	}

	/** Stop the elapsed-time ticker (the view is closing mid-stream). */
	dispose(): void {
		this.stopTicker();
	}

	private updateLabel(): void {
		const seconds = ((this.endedAt || Date.now()) - this.startedAt) / 1000;
		this.labelEl.setText(
			`${this.endedAt ? this.opts.doneLabel : this.opts.busyLabel} ${seconds.toFixed(1)}s`,
		);
	}

	private startTicker(): void {
		if (this.ticker !== null) return;
		this.ticker = this.el.win.setInterval(() => this.updateLabel(), 200);
	}

	private stopTicker(): void {
		if (this.ticker === null) return;
		this.el.win.clearInterval(this.ticker);
		this.ticker = null;
	}
}
