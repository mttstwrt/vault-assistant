/**
 * Cooperative cancellation for the agent loop.
 *
 * Obsidian's `requestUrl` takes no abort signal, so a stopped request still
 * finishes on the wire — what we can do is stop *waiting* for it and drop the
 * result. That is the difference between a Stop button that reacts now and one
 * that reacts once the model is done, which is no stop button at all.
 */

/** Thrown by `untilStopped` when the signal fires before the work settles. */
export class StoppedError extends Error {
	constructor() {
		super('Stopped by the user.');
		this.name = 'StoppedError';
	}
}

/** True when `e` is the rejection `untilStopped` uses for a user stop. */
export function isStopped(e: unknown): boolean {
	return e instanceof StoppedError;
}

/** Resolve `work`, or reject with `StoppedError` as soon as `signal` aborts. */
export function untilStopped<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return work;
	if (signal.aborted) return Promise.reject(new StoppedError());
	return new Promise<T>((resolve, reject) => {
		const onAbort = (): void => reject(new StoppedError());
		signal.addEventListener('abort', onAbort, { once: true });
		void work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
	});
}
