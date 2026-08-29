/**
 * How much of the model's context window this conversation is using, as a ring
 * beside the model it belongs to, with the figures behind it on hover.
 *
 * Both numbers are measured rather than estimated. What is used is the last
 * request's `prompt_tokens` plus the answer that came back — the tokens the
 * endpoint itself counted, which together are what the next request will carry.
 * The window comes from llama.cpp's /props. An endpoint that reports neither
 * gets no ring: a guessed context bar is worse than none, because the number it
 * shows would be believed.
 */

/** Geometry of the ring, in the units of its 20×20 viewBox. */
const RADIUS = 7;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** Where the ring changes colour: getting full, and nearly out. */
const WARN_AT = 0.75;
const DANGER_AT = 0.9;

/** What the endpoint counted for the last exchange, and what it counted against. */
export interface ContextUse {
	/** Tokens in the last prompt: the conversation as the model last read it. */
	promptTokens: number;
	/** Tokens in the answer to it, which the next prompt will carry too. */
	completionTokens: number;
	/** The window those fill. */
	contextSize: number;
	/** Whose window it is, for the popup. */
	model: string;
}

export class ContextRing {
	private el: HTMLElement;
	private fill: SVGCircleElement;
	private label: HTMLElement;
	private popup: HTMLElement;
	private shown = false;

	constructor(parent: HTMLElement) {
		this.el = parent.createSpan({ cls: 'va-context va-hidden' });

		const svg = this.el.createSvg('svg', {
			cls: 'va-context-ring',
			attr: { viewBox: '0 0 20 20', 'aria-hidden': 'true' },
		});
		const circle = (cls: string): SVGCircleElement =>
			svg.createSvg('circle', {
				cls,
				attr: { cx: '10', cy: '10', r: String(RADIUS), fill: 'none' },
			});
		circle('va-context-track');
		this.fill = circle('va-context-fill');
		// The arc is drawn as a dashed stroke whose first dash is the filled
		// part; rotating the whole ring starts it at twelve o'clock.
		this.fill.setAttr('stroke-dasharray', `0 ${CIRCUMFERENCE}`);

		this.label = this.el.createSpan({ cls: 'va-context-label' });

		// Built once and shown by class, so hovering costs no layout work.
		this.popup = this.el.createDiv({ cls: 'va-context-popup va-hidden' });
		const reveal = (visible: boolean): void => this.popup.toggleClass('va-hidden', !visible);
		this.el.addEventListener('mouseenter', () => reveal(true));
		this.el.addEventListener('mouseleave', () => reveal(false));
		// Reachable without a mouse: the ring takes focus, and says what it is.
		this.el.tabIndex = 0;
		this.el.addEventListener('focus', () => reveal(true));
		this.el.addEventListener('blur', () => reveal(false));
	}

	/** Whether there is anything to show. */
	get visible(): boolean {
		return this.shown;
	}

	/** Show what `use` describes, or hide the ring when there is nothing to show. */
	update(use: ContextUse | null): void {
		if (!use || use.contextSize <= 0 || use.promptTokens <= 0) {
			this.hide();
			return;
		}

		const used = use.promptTokens + use.completionTokens;
		// A conversation can outgrow the window the server reported (a model
		// swapped behind the same endpoint, a server that grew its slots); a
		// ring past full would look broken, so it pins and the figures tell the
		// truth underneath.
		const ratio = Math.min(used / use.contextSize, 1);
		const percent = Math.min(Math.round((used / use.contextSize) * 100), 100);

		this.fill.setAttr('stroke-dasharray', `${ratio * CIRCUMFERENCE} ${CIRCUMFERENCE}`);
		this.el.toggleClass('va-context-warn', ratio >= WARN_AT && ratio < DANGER_AT);
		this.el.toggleClass('va-context-danger', ratio >= DANGER_AT);
		this.label.setText(`${percent}%`);
		this.el.setAttr('aria-label', `Context: ${percent}% of ${compact(use.contextSize)} tokens used`);

		this.renderPopup(use, used, percent);
		this.el.removeClass('va-hidden');
		this.shown = true;
	}

	hide(): void {
		this.el.addClass('va-hidden');
		this.popup.addClass('va-hidden');
		this.shown = false;
	}

	private renderPopup(use: ContextUse, used: number, percent: number): void {
		const free = Math.max(use.contextSize - used, 0);
		this.popup.empty();
		this.popup.createDiv({ cls: 'va-context-popup-title', text: 'Context window' });
		this.popup.createDiv({
			text: `${count(used)} of ${count(use.contextSize)} tokens · ${percent}%`,
		});
		this.popup.createDiv({ text: `${count(free)} free` });
		this.popup.createDiv({
			cls: 'va-context-popup-note',
			text:
				`Last exchange: ${count(use.promptTokens)} prompt + ${count(use.completionTokens)} answer, ` +
				`counted by the endpoint for ${use.model || 'this model'}.`,
		});
	}
}

/** 12431 → "12,431", for the popup, where the exact figure is the point. */
function count(tokens: number): string {
	return tokens.toLocaleString();
}

/** 32768 → "33k", for the one-line label. */
function compact(tokens: number): string {
	if (tokens < 1000) return String(tokens);
	const thousands = tokens / 1000;
	return `${thousands < 10 ? thousands.toFixed(1) : Math.round(thousands)}k`;
}
