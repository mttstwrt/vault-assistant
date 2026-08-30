/**
 * Model discovery. Every OpenAI-compatible server answers `GET /models` with
 * the models it can serve: llama.cpp lists the loaded model (and all of them
 * when it is running as a router), Ollama lists what you have pulled, and
 * LM Studio, OpenAI and OpenRouter list their catalogue. Endpoints that don't
 * implement it are no worse off — the model name stays a text field.
 *
 * A router additionally says what state each model is in, which is worth
 * carrying: picking one that isn't loaded means the next message waits for
 * weights, and that is better known before choosing than after.
 */
import { requestUrl } from 'obsidian';
import { describeRequestError, directRequest, withDirectRetry } from './node-http';

/** What an endpoint said about one model it serves. */
export interface ModelEntry {
	id: string;
	/**
	 * Whether the model is ready to answer. Only llama.cpp's router reports
	 * this; everywhere else it is undefined and nothing is claimed.
	 */
	state?: 'loaded' | 'loading' | 'unloaded';
}

interface ModelsResponse {
	data?: Array<{ id?: string; status?: { value?: string } }>;
	/** Some proxies answer with this shape instead of the OpenAI one. */
	models?: Array<{ id?: string; name?: string; status?: { value?: string } }>;
}

/**
 * llama.cpp's six router states, as the three a chooser cares about. Sleeping
 * counts as loaded: the weights are still resident, the server has only idled
 * the context. A model still downloading is on its way, so it groups with
 * loading.
 */
function toState(status: string | undefined): ModelEntry['state'] {
	switch (status) {
		case 'loaded':
		case 'sleeping':
			return 'loaded';
		case 'loading':
		case 'downloading':
			return 'loading';
		case 'unloaded':
		case 'downloaded':
			return 'unloaded';
		default:
			return undefined;
	}
}

/** One lookup per endpoint, shared between the panel and the settings tab. */
const cache = new Map<string, Promise<ModelEntry[]>>();

/** Ask an endpoint which models it serves, newest naming first come first served. */
export function listModels(baseUrl: string, apiKey: string): Promise<ModelEntry[]> {
	const base = baseUrl.trim().replace(/\/+$/, '');
	if (!base) return Promise.reject(new Error('no base URL is configured'));

	const hit = cache.get(base);
	if (hit) return hit;

	// A failure is not cached: the endpoint may simply not be up yet, and the
	// refresh button has to be able to find it once it is.
	const lookup = fetchModels(base, apiKey).catch((e: unknown) => {
		cache.delete(base);
		throw e;
	});
	cache.set(base, lookup);
	return lookup;
}

async function fetchModels(base: string, apiKey: string): Promise<ModelEntry[]> {
	const headers: Record<string, string> = {};
	if (apiKey.trim()) headers['Authorization'] = `Bearer ${apiKey.trim()}`;

	const url = `${base}/models`;
	const res = await withDirectRetry(
		url,
		async () => {
			const r = await requestUrl({ url, method: 'GET', headers, throw: false });
			return { status: r.status, text: r.text ?? '' };
		},
		() => directRequest({ url, method: 'GET', headers }),
	).catch((e: unknown) => {
		throw new Error(describeRequestError(e, url));
	});

	if (res.status >= 400) {
		const detail = res.text.trim().slice(0, 120);
		throw new Error(`the endpoint answered ${res.status}${detail ? ` (${detail})` : ''}`);
	}

	let json: ModelsResponse;
	try {
		json = JSON.parse(res.text) as ModelsResponse;
	} catch {
		throw new Error('the endpoint did not return a model list');
	}

	const listed = [
		...(json?.data ?? []).map((m) => ({ id: m.id, status: m.status })),
		...(json?.models ?? []).map((m) => ({ id: m.id ?? m.name, status: m.status })),
	];

	const entries: ModelEntry[] = [];
	const seen = new Set<string>();
	for (const m of listed) {
		const id = typeof m.id === 'string' ? m.id.trim() : '';
		if (!id || seen.has(id)) continue;
		seen.add(id);
		entries.push({ id, state: toState(m.status?.value) });
	}
	return entries.sort((a, b) => a.id.localeCompare(b.id, undefined, { sensitivity: 'base' }));
}

/** Forget what the endpoints said, so a changed URL or key is looked up again. */
export function clearModelCache(): void {
	cache.clear();
}

/** Models that are never a chat model, however the endpoint names them. */
const NOT_CHAT =
	/(?:embed|rerank|whisper|tts|text-to-speech|speech|audio|dall-e|stable-diffusion|moderation|guard)/i;

/**
 * Narrow a discovered list to the models worth offering for `kind`. A filter
 * that would leave nothing is dropped instead — a name we failed to recognise
 * is better than an empty list.
 */
export function filterModels(models: ModelEntry[], kind: 'chat' | 'embed'): ModelEntry[] {
	const narrowed =
		kind === 'embed'
			? models.filter((m) => /embed/i.test(m.id))
			: models.filter((m) => !NOT_CHAT.test(m.id));
	return narrowed.length > 0 ? narrowed : models;
}

/**
 * A readable label for a model id. llama.cpp reports the path of the file it
 * loaded, which is unreadable in a dropdown; the id itself is what gets sent.
 */
export function modelLabel(id: string): string {
	const name = id.split(/[\\/]/).pop() ?? id;
	return name.replace(/\.gguf$/i, '') || id;
}

/** The label plus what the endpoint said about the model's readiness. */
export function modelOptionLabel(model: ModelEntry): string {
	const name = modelLabel(model.id);
	switch (model.state) {
		case 'loaded':
			return `${name} · loaded`;
		case 'loading':
			return `${name} · loading`;
		case 'unloaded':
			return `${name} · not loaded`;
		default:
			return name;
	}
}
