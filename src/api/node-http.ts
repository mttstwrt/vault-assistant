/**
 * A direct connection to a model server running on this machine.
 *
 * Both ways Obsidian can make a request — `requestUrl` and the renderer's
 * `fetch` — go through Chromium's network stack, which refuses everything with
 * `ERR_INTERNET_DISCONNECTED` while the OS reports no network interface. That
 * verdict is wrong for `127.0.0.1`: a model server on the same PC needs no
 * internet at all. When a request to a loopback address fails that way, it is
 * retried here over Node's http, which talks to the socket directly.
 *
 * Desktop only (there is no local server to reach on mobile), and only for
 * loopback addresses, so remote endpoints keep using Chromium — with its proxy
 * settings and the system certificate store.
 */
import { Platform } from 'obsidian';
import type * as NodeHttp from 'http';

export interface DirectRequest {
	url: string;
	method: 'GET' | 'POST';
	headers: Record<string, string>;
	body?: string;
	signal?: AbortSignal;
	/** When set, body text is reported as it arrives instead of buffered. */
	onChunk?: (text: string) => void;
}

export interface DirectResponse {
	status: number;
	/** The whole body, or '' when it went to onChunk. */
	text: string;
}

/** Hostnames that are this machine, where internet connectivity is irrelevant. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);

/** Chromium's "this machine has no network" family of refusals. */
const OFFLINE = /ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_NAME_NOT_RESOLVED|ERR_ADDRESS_UNREACHABLE|Failed to fetch|NetworkError/i;

/** Whether `url` points at a server on this machine. */
export function isLocalEndpoint(url: string): boolean {
	try {
		const host = new URL(url).hostname.toLowerCase();
		return LOOPBACK.has(host) || host.endsWith('.localhost');
	} catch {
		return false;
	}
}

/** Whether a failed request to `url` can be retried over a direct connection. */
export function canRetryDirect(url: string): boolean {
	return Platform.isDesktopApp && isLocalEndpoint(url);
}

/** Whether this failure is Chromium declaring the machine offline. */
export function isOfflineError(e: unknown): boolean {
	return OFFLINE.test(e instanceof Error ? e.message : String(e));
}

/**
 * Run a request, and when Chromium refuses it as offline, run it again over a
 * direct connection to the local server. Anything else is left to the caller.
 */
export async function withDirectRetry<T>(
	url: string,
	viaObsidian: () => Promise<T>,
	direct: () => Promise<T>,
): Promise<T> {
	try {
		return await viaObsidian();
	} catch (e) {
		if (!canRetryDirect(url) || !isOfflineError(e)) throw e;
		console.warn(
			`[vault-assistant] The system reports no network; connecting to ${url} directly instead.`,
			e,
		);
		return await direct();
	}
}

/** Say what actually went wrong, rather than passing on a Chromium error code. */
export function describeRequestError(e: unknown, url: string): string {
	const message = e instanceof Error ? e.message : String(e);
	if (!isOfflineError(e)) return message;
	return isLocalEndpoint(url)
		? `Could not reach ${url} (${message}). It is on this machine, so check the server is running and listening on that port.`
		: `Could not reach ${url} (${message}). This machine reports no network connection.`;
}

function nodeHttp(secure: boolean): typeof NodeHttp {
	// Lazy require so this module still loads where Node isn't available.
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	if (secure) return require('https') as typeof NodeHttp;
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	return require('http') as typeof NodeHttp;
}

/** One request over Node's http/https, bypassing Chromium entirely. */
export function directRequest(opts: DirectRequest): Promise<DirectResponse> {
	const url = new URL(opts.url);
	const secure = url.protocol === 'https:';
	const headers = { ...opts.headers };
	if (opts.body !== undefined) {
		headers['Content-Length'] = String(new TextEncoder().encode(opts.body).length);
	}

	return new Promise<DirectResponse>((resolve, reject) => {
		const req = nodeHttp(secure).request(
			{
				protocol: url.protocol,
				hostname: url.hostname,
				port: url.port || (secure ? 443 : 80),
				path: `${url.pathname}${url.search}`,
				method: opts.method,
				headers,
			},
			(res) => {
				res.setEncoding('utf8');
				// An error response has a body worth reporting, so it is
				// buffered even when the caller asked for a stream.
				const stream = !!opts.onChunk && (res.statusCode ?? 0) < 400;
				let text = '';
				res.on('data', (chunk: string) => {
					if (stream) opts.onChunk?.(chunk);
					else text += chunk;
				});
				res.on('end', () => {
					cleanup();
					resolve({ status: res.statusCode ?? 0, text });
				});
				res.on('error', fail);
			},
		);

		const abort = (): void => {
			req.destroy(new DOMException('Aborted', 'AbortError'));
		};
		const cleanup = (): void => opts.signal?.removeEventListener('abort', abort);

		function fail(e: Error): void {
			cleanup();
			reject(e);
		}
		req.on('error', fail);

		if (opts.signal) {
			if (opts.signal.aborted) {
				req.destroy();
				reject(new DOMException('Aborted', 'AbortError'));
				return;
			}
			opts.signal.addEventListener('abort', abort, { once: true });
		}

		if (opts.body !== undefined) req.write(opts.body);
		req.end();
	});
}
