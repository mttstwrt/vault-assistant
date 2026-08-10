/** A composer that grows with what you type, up to the height its CSS allows. */

/** Resize `el` to fit its content, clamped to the CSS max-height. */
export function fitToContent(el: HTMLTextAreaElement): void {
	el.style.removeProperty('height');
	const style = el.win.getComputedStyle(el);
	// scrollHeight covers content + padding; borders are extra under border-box.
	const border =
		(parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0);
	const max = parseFloat(style.maxHeight);
	const wanted = el.scrollHeight + border;
	const height = Number.isFinite(max) ? Math.min(wanted, max) : wanted;
	el.style.setProperty('height', `${height}px`);
}
