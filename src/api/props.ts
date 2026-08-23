/**
 * Working out which reasoning-effort levels a model actually has.
 *
 * There is no standard for this: OpenAI's /v1/models returns an id and little
 * else, and nothing in the OpenAI schema enumerates the values
 * `reasoning_effort` accepts. llama.cpp gets closer — GET /props (at the
 * server root, not under /v1) returns the model's whole Jinja chat template,
 * and since llama.cpp simply hands `reasoning_effort` to that template, the
 * template is the ground truth for which levels do anything at all.
 *
 * So this reads the template and looks for the level names llama.cpp
 * documents. It is a heuristic, and it says so: anything it cannot establish
 * comes back as null and the caller offers the full list instead.
 */
import { requestUrl } from 'obsidian';
import { ReasoningEffort } from '../settings';
import { describeRequestError, directRequest, withDirectRetry } from './node-http';

/**
 * Every level llama.cpp's --reasoning-effort documents, plus `none`, which its
 * server treats specially: it turns thinking off rather than reaching the
 * template.
 */
export const EFFORT_LEVELS: ReasoningEffort[] = [
	'none',
	'minimal',
	'low',
	'medium',
	'high',
	'xhigh',
	'max',
];

/** Fewer than this many hits is coincidence, not a set of levels. */
const MIN_LEVELS = 2;

interface ServerProps {
	chat_template?: string;
}

/** One lookup per endpoint, shared between callers and kept for the session. */
const cache = new Map<string, Promise<ReasoningEffort[] | null>>();

/** The server root: /props sits beside /v1, not inside it. */
function propsUrl(baseUrl: string): string {
	const base = baseUrl.trim().replace(/\/+$/, '');
	return `${base.replace(/\/v\d+$/, '')}/props`;
}

/**
 * The levels a chat template reacts to, or null when the template doesn't
 * mention `reasoning_effort` at all (so nothing can be concluded).
 */
export function effortLevelsInTemplate(template: string): ReasoningEffort[] | null {
	if (!/reasoning_effort/i.test(template)) return null;
	// Quoted, so Jinja's own `none` and the `max` filter don't count.
	const found = EFFORT_LEVELS.filter((level) =>
		new RegExp(`['"]${level}['"]`, 'i').test(template),
	);
	return found.length >= MIN_LEVELS ? found : null;
}

/**
 * Ask the endpoint which effort levels its model understands. Returns null
 * whenever that can't be established — a server without /props, a template
 * that ignores the parameter, or any failure at all.
 */
export function serverEffortLevels(
	baseUrl: string,
	apiKey: string,
): Promise<ReasoningEffort[] | null> {
	const url = propsUrl(baseUrl);
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
			return effortLevelsInTemplate(props?.chat_template ?? '');
		})
		.catch((e: unknown) => {
			// Endpoints that don't serve /props are the common case, not an error.
			console.debug('[vault-assistant] No effort levels from', url, describeRequestError(e, url));
			return null;
		});

	cache.set(url, lookup);
	return lookup;
}

/** Forget what an endpoint said, so a model swap can be picked up. */
export function clearEffortCache(): void {
	cache.clear();
}
