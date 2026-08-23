/**
 * Model discovery. Every OpenAI-compatible server answers `GET /models` with
 * the models it can serve: llama.cpp lists the loaded model (and all of them
 * when it is running as a router), Ollama lists what you have pulled, and
 * LM Studio, OpenAI and OpenRouter list their catalogue. Endpoints that don't
 * implement it are no worse off — the model name stays a text field.
 */
import { requestUrl } from 'obsidian';
import { describeRequestError, directRequest, withDirectRetry } from './node-http';

interface ModelsResponse {
	data?: Array<{ id?: string }>;
	/** Some proxies answer with this shape instead of the OpenAI one. */
	models?: Array<{ id?: string; name?: string }>;
}

/** Ask an endpoint which models it serves, newest naming first come first served. */
export async function listModels(baseUrl: string, apiKey: string): Promise<string[]> {
	const base = baseUrl.trim().replace(/\/+$/, '');
	if (!base) throw new Error('no base URL is configured');

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

	const ids = [
		...(json?.data ?? []).map((m) => m.id),
		...(json?.models ?? []).map((m) => m.id ?? m.name),
	]
		.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
		.map((id) => id.trim());

	return [...new Set(ids)].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

/** Models that are never a chat model, however the endpoint names them. */
const NOT_CHAT =
	/(?:embed|rerank|whisper|tts|text-to-speech|speech|audio|dall-e|stable-diffusion|moderation|guard)/i;

/**
 * Narrow a discovered list to the models worth offering for `kind`. A filter
 * that would leave nothing is dropped instead — a name we failed to recognise
 * is better than an empty list.
 */
export function filterModels(ids: string[], kind: 'chat' | 'embed'): string[] {
	const narrowed =
		kind === 'embed'
			? ids.filter((id) => /embed/i.test(id))
			: ids.filter((id) => !NOT_CHAT.test(id));
	return narrowed.length > 0 ? narrowed : ids;
}

/**
 * A readable label for a model id. llama.cpp reports the path of the file it
 * loaded, which is unreadable in a dropdown; the id itself is what gets sent.
 */
export function modelLabel(id: string): string {
	const name = id.split(/[\\/]/).pop() ?? id;
	return name.replace(/\.gguf$/i, '') || id;
}
