/**
 * How much of the model's context window this conversation is using, as a
 * ring in the panel header.
 *
 * Both numbers come from the endpoint rather than from counting here: the
 * window from llama.cpp's /props (see api/props.ts), the usage from what the
 * newest completion reported. Each request re-sends the whole conversation, so
 * the most recent call's prompt *is* the conversation's footprint — which is
 * also why the ring grows during a single message, as tool results pile into
 * the history. An endpoint that reports neither leaves an empty ring that says
 * the size is unknown, which is the honest answer.
 *
 * Geometry and thresholds follow llama.cpp's own gauge, so a user who has both
 * open sees the same picture twice rather than two disagreeing ones.
 */
import { CallStats } from '../api/client';

/** A 32×32 box with an r=11 ring, as llama.cpp's ContextGaugeDial draws it. */
const RADIUS = 11;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** Where the ring changes colour, matching that gauge's thresholds. */
const WARNING_PERCENT = 80;
const CRITICAL_PERCENT = 95;

export class ContextRing {
	private el: HTMLElement;
	private arc: SVGCircleElement;
	/** The model's context window, when the endpoint would say. */
	private total: number | null = null;
	/** What the newest turn read and wrote; null until one has. */
	private used: number | null = null;

	constructor(parent: HTMLElement) {
		this.el = parent.createDiv({ cls: 'va-ring', attr: { 'aria-label': 'Context usage' } });
		const svg = this.el.createSvg('svg', { attr: { viewBox: '0 0 32 32', fill: 'none' } });
		const circle = { cx: 16, cy: 16, r: RADIUS, stroke: 'currentColor', 'stroke-width': 3 };
		svg.createSvg('circle', { cls: 'va-ring-track', attr: circle });
		this.arc = svg.createSvg('circle', {
			cls: 'va-ring-arc',
			attr: {
				...circle,
				'stroke-dasharray': CIRCUMFERENCE,
				'stroke-dashoffset': CIRCUMFERENCE,
				'stroke-linecap': 'round',
				// Start the arc at twelve o'clock instead of three.
				transform: 'rotate(-90 16 16)',
			},
		});
		this.draw();
	}

	/** The context window the model is served with; null when unknown. */
	setTotal(total: number | null): void {
		this.total = total;
		this.draw();
	}

	/** Take the newest turn's numbers. A turn that reported none is ignored. */
	report(stats: CallStats): void {
		const used = (stats.promptTokens ?? 0) + (stats.completionTokens ?? 0);
		if (used <= 0) return;
		this.used = used;
		this.draw();
	}

	/** A different conversation: a saved transcript carries no token counts. */
	reset(): void {
		this.used = null;
		this.draw();
	}

	private draw(): void {
		const percent = this.used !== null && this.total ? (this.used * 100) / this.total : null;
		// A conversation can outgrow its window; the arc stops at full, the
		// tooltip keeps reporting the real figure.
		const filled = percent === null ? 0 : Math.min(Math.max(percent, 0), 100);
		this.arc.setAttr('stroke-dashoffset', CIRCUMFERENCE * (1 - filled / 100));
		this.el.toggleClass('is-warning', percent !== null && percent >= WARNING_PERCENT);
		this.el.toggleClass('is-critical', percent !== null && percent >= CRITICAL_PERCENT);
		this.el.setAttr('title', this.label(percent));
	}

	private label(percent: number | null): string {
		if (this.used === null) return 'Context usage — no answers yet';
		const used = this.used.toLocaleString();
		if (percent === null || this.total === null) return `${used} tokens · context size unknown`;
		return `${used} / ${this.total.toLocaleString()} tokens · ${Math.round(percent)}% used`;
	}
}
