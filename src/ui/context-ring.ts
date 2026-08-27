/**
 * How much of the model's context window this conversation is using, as a
 * ring beside the status line.
 *
 * Both numbers are measured rather than estimated. The used figure is
 * `prompt_tokens` from the last response — the tokens the endpoint itself
 * counted for the prompt it just read, which is exactly what the conversation
 * occupies. The window comes from llama.cpp's /props. An endpoint that reports
 * neither gets no ring at all: a guessed context bar is worse than none, since
 * the number it shows would be believed.
 */

/** Geometry of the ring, in the units of its 20×20 viewBox. */
const RADIUS = 7;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** Where the ring changes colour: getting full, and nearly out. */
const WARN_AT = 0.75;
const DANGER_AT = 0.9;

export class ContextRing {
	private el: HTMLElement;
	private fill: SVGCircleElement;
	private label: HTMLElement;
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
	}

	/** Whether there is anything to show, so the strip can size itself. */
	get visible(): boolean {
		return this.shown;
	}

	/**
	 * Show `used` of `total` tokens. Either one missing hides the ring — that
	 * is the endpoint declining to say, not a conversation using nothing.
	 */
	update(used: number | null, total: number | null): void {
		if (!used || !total || total <= 0) {
			this.hide();
			return;
		}

		// A prompt can exceed the window the server reported (a model swapped
		// behind the same endpoint, a server that grew its slots); a ring past
		// full would just look broken, so it pins and the number tells the truth.
		const ratio = Math.min(used / total, 1);
		this.fill.setAttr('stroke-dasharray', `${ratio * CIRCUMFERENCE} ${CIRCUMFERENCE}`);
		this.el.toggleClass('va-context-warn', ratio >= WARN_AT && ratio < DANGER_AT);
		this.el.toggleClass('va-context-danger', ratio >= DANGER_AT);

		this.label.setText(`${Math.round((used / total) * 100)}%`);
		this.el.setAttr(
			'aria-label',
			`Context: ${compact(used)} of ${compact(total)} tokens (${Math.round((used / total) * 100)}%)`,
		);
		this.el.setAttr(
			'title',
			`${compact(used)} of ${compact(total)} tokens of context used, as counted by the endpoint.`,
		);
		this.el.removeClass('va-hidden');
		this.shown = true;
	}

	hide(): void {
		this.el.addClass('va-hidden');
		this.shown = false;
	}
}

/** 12400 → "12.4k", so the tooltip stays one short line. */
function compact(tokens: number): string {
	if (tokens < 1000) return String(tokens);
	const thousands = tokens / 1000;
	return `${thousands < 10 ? thousands.toFixed(1) : Math.round(thousands)}k`;
}
