/**
 * What the model is served with, read from llama.cpp's `GET /props`.
 *
 * There is no standard for any of this. The OpenAI schema says nothing about a
 * model's context window and nothing about the sampler settings a server was
 * launched with, so an endpoint that doesn't volunteer them leaves a front end
 * guessing. llama.cpp volunteers both, in `default_generation_settings`:
 * `n_ctx` is the context of one slot, which is the budget for a single request
 * rather than the sum across `--parallel`, and so exactly what a usage
 * indicator should measure against; the rest is what a request that sets
 * nothing will actually get.
 *
 * Anything that can't be established comes back as null, and the panel says
 * the size is unknown rather than showing a wrong one. An endpoint without
 * /props is the common case, not an error — there, a sampler this plugin
 * leaves unset is simply whatever the server chose, unseen.
 */
import { requestUrl } from 'obsidian';
import { describeRequestError, directRequest, withDirectRetry } from './node-http';

interface ServerProps {
	default_generation_settings?: {
		n_ctx?: number;
		temperature?: number;
		presence_penalty?: number;
		repeat_penalty?: number;
	};
}

/**
 * What the server was launched with.
 *
 * `default_generation_settings` is the whole sampler set `llama-server` will
 * apply to a request that says nothing — the same thing llama.cpp's own UI
 * seeds its controls from. This plugin leaves a sampler unset by default and
 * sends nothing for it, so these are the values actually in force; showing them
 * is what keeps "unset" from meaning "unknowable".
 *
 * Only the ones with a control here are read. `contextSize` is null when the
 * endpoint would not say — see {@link serverContextSize}.
 */
export interface ServerDefaults {
	contextSize: number | null;
	temperature?: number;
	presencePenalty?: number;
	repeatPenalty?: number;
}

/** One lookup per endpoint and model, shared between callers, kept for the session. */
const cache = new Map<string, Promise<ServerDefaults | null>>();

/**
 * Endpoints that answered /props with a real context size.
 *
 * Only llama.cpp serves this endpoint, so an answer is a reliable fingerprint —
 * and the one thing worth doing with it is asking for the extras llama.cpp
 * alone understands. Everything else must keep seeing a plain OpenAI request:
 * hosted APIs reject body fields they do not know, so a parameter the user did
 * not ask for is never sent speculatively.
 */
const llamaCpp = new Set<string>();

/** Whether this endpoint has identified itself as llama.cpp by answering /props. */
export function servesLlamaCppProps(baseUrl: string, model: string): boolean {
	return llamaCpp.has(propsUrl(baseUrl, model));
}

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
 * What `model` is served with, or null whenever the endpoint would not say.
 *
 * A null is cached like any other answer, because this is asked again on every
 * settings change and an endpoint without /props would otherwise be re-asked
 * per keystroke. `refresh` is how a caller says the precondition has changed:
 * on a router, a model that was not resident when first asked (the lookup
 * carries `autoload=false`) reports nothing until something loads it, and the
 * fact that it has just answered is the proof that something did.
 */
export function serverDefaults(
	baseUrl: string,
	apiKey: string,
	model: string,
	refresh = false,
): Promise<ServerDefaults | null> {
	const url = propsUrl(baseUrl, model);
	if (refresh) cache.delete(url);
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
		.then((res): ServerDefaults | null => {
			if (res.status >= 400) return null;
			const props = JSON.parse(res.text) as ServerProps;
			const defaults = props?.default_generation_settings;
			if (!defaults) return null;
			llamaCpp.add(url);
			const n = defaults.n_ctx;
			return {
				contextSize: typeof n === 'number' && n > 0 ? n : null,
				temperature: defaults.temperature,
				presencePenalty: defaults.presence_penalty,
				repeatPenalty: defaults.repeat_penalty,
			};
		})
		.catch((e: unknown) => {
			console.debug('[vault-assistant] No server defaults from', url, describeRequestError(e, url));
			return null;
		});

	cache.set(url, lookup);
	return lookup;
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
	refresh = false,
): Promise<number | null> {
	return serverDefaults(baseUrl, apiKey, model, refresh).then((d) => d?.contextSize ?? null);
}

/** Forget what an endpoint said, so a model or endpoint swap is picked up. */
export function clearPropsCache(): void {
	cache.clear();
	llamaCpp.clear();
}
