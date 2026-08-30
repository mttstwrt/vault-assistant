/**
 * How much context the model has, read from llama.cpp's `GET /props`.
 *
 * There is no standard for this: the OpenAI schema says nothing about a
 * model's context window, so an endpoint that doesn't volunteer the number
 * leaves a front end guessing. llama.cpp volunteers it —
 * `default_generation_settings.n_ctx` is the context of one slot, which is the
 * budget for a single request rather than the sum across `--parallel`, and so
 * exactly what a usage indicator should measure against.
 *
 * Anything that can't be established comes back as null, and the panel says
 * the size is unknown rather than showing a wrong one. An endpoint without
 * /props is the common case, not an error.
 */
import { requestUrl } from 'obsidian';
import { describeRequestError, directRequest, withDirectRetry } from './node-http';

interface ServerProps {
	default_generation_settings?: { n_ctx?: number };
}

/** One lookup per endpoint and model, shared between callers, kept for the session. */
const cache = new Map<string, Promise<number | null>>();

/**
 * The /props URL for one model. Two llama.cpp details shape it:
 *
 * - /props sits at the server root, beside /v1, not inside it.
 * - A router answers a bare /props for itself, with a dummy `n_ctx: 0`; the
 *   real answer comes from `?model=`. `autoload=false` keeps that question
 *   from loading the model to answer it, which would spend thirty seconds of
 *   weights on "how big is the context". A single-model server ignores both.
 */
function propsUrl(baseUrl: string, model: string): string {
	const root = baseUrl.trim().replace(/\/+$/, '').replace(/\/v\d+$/, '');
	const name = model.trim();
	const query = name ? `?model=${encodeURIComponent(name)}&autoload=false` : '';
	return `${root}/props${query}`;
}

/**
 * The context window `model` is served with, or null whenever that can't be
 * established — an endpoint without /props, a router speaking for itself
 * (`n_ctx: 0`), or any failure at all.
 */
export function serverContextSize(
	baseUrl: string,
	apiKey: string,
	model: string,
): Promise<number | null> {
	const url = propsUrl(baseUrl, model);
	const hit = cache.get(url);
	if (hit) return hit;

	const headers: Record<string, string> = {};
	if (apiKey.trim()) headers['Authorization'] = `Bearer ${apiKey.trim()}`;

	const lookup = withDirectRetry(
		url,
		async () => {
			const r = await requestUrl({ url, method: 'GET', headers, throw: false });
			return { status: r.status, text: r.text ?? '' };
		},
		() => directRequest({ url, method: 'GET', headers }),
	)
		.then((res) => {
			if (res.status >= 400) return null;
			const props = JSON.parse(res.text) as ServerProps;
			const n = props?.default_generation_settings?.n_ctx;
			return typeof n === 'number' && n > 0 ? n : null;
		})
		.catch((e: unknown) => {
			console.debug('[vault-assistant] No context size from', url, describeRequestError(e, url));
			return null;
		});

	cache.set(url, lookup);
	return lookup;
}

/** Forget what an endpoint said, so a model or endpoint swap is picked up. */
export function clearPropsCache(): void {
	cache.clear();
}
