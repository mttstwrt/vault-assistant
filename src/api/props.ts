/**
 * What an endpoint will say about the model it is serving: which
 * reasoning-effort levels it has, and how big its context window is.
 *
 * There is no standard for this: OpenAI's /v1/models returns an id and little
 * else, and nothing in the OpenAI schema enumerates the values
 * `reasoning_effort` accepts. llama.cpp gets closer — GET /props (at the
 * server root, not under /v1) returns the model's whole Jinja chat template,
 * and since llama.cpp simply hands `reasoning_effort` to that template, the
 * template is the ground truth for which levels do anything at all.
 *
 * Templates come in two shapes, and only one of them can be read. A template
 * that *branches* on the value (`{%- if reasoning_effort == 'high' %}`) names
 * its levels outright. A template that *interpolates* it (gpt-oss:
 * `"Reasoning: " + reasoning_effort`) accepts any string and means only what
 * the model was trained on, which is nowhere in the file — an unknown level
 * there is not ignored, it lands in the system message as `Reasoning: xhigh`.
 *
 * So the answer is deliberately four-way (see EffortSupport): the caller
 * narrows what it offers only as far as the endpoint actually established,
 * and a lookup that failed never passes for one that came back empty.
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

/**
 * The levels a template can be read for. `none` is excluded because the server
 * acts on it before the template runs: its absence from a template is not
 * evidence the model lacks it, and its presence is not evidence of a level
 * set. Callers offer it whenever the endpoint answered at all.
 */
const TEMPLATE_LEVELS = EFFORT_LEVELS.filter((l) => l !== 'none');

/**
 * Levels that essentially every model taking `reasoning_effort` has. Offered
 * when the parameter demonstrably reaches the model but the template keeps
 * the level set to itself.
 */
export const COMMON_EFFORT_LEVELS: ReasoningEffort[] = ['none', 'low', 'medium', 'high'];

/** Fewer than this many hits is coincidence, not a set of levels. */
const MIN_LEVELS = 2;

/** Jinja delimiters: `{{ expr }}`, `{% statement %}`, `{# comment #}`. */
const JINJA_BLOCK = /\{[{%#][\s\S]*?[}%#]\}/g;

/** What an endpoint managed to establish about its model's effort levels. */
export type EffortSupport =
	/** The template branches on exactly these levels. */
	| { kind: 'levels'; levels: ReasoningEffort[] }
	/** The template never reads `reasoning_effort`: the parameter does nothing. */
	| { kind: 'ignored' }
	/** It reaches the model, but the template doesn't enumerate its levels. */
	| { kind: 'unenumerated' }
	/** The endpoint wouldn't say — nothing can be concluded either way. */
	| { kind: 'unknown' };

interface ServerProps {
	chat_template?: string;
	/** Some builds report the window at the root; others only per-slot. */
	n_ctx?: number;
	default_generation_settings?: { n_ctx?: number };
}

/** What one endpoint told us about the model it is serving. */
export interface ServerFacts {
	effort: EffortSupport;
	/** Context window in tokens, or null when the endpoint didn't say. */
	contextSize: number | null;
}

/** Nothing established: an endpoint that wouldn't answer, or couldn't be read. */
const NOTHING: ServerFacts = { effort: { kind: 'unknown' }, contextSize: null };

/** One lookup per endpoint, shared between callers and kept for the session. */
const cache = new Map<string, Promise<ServerFacts>>();

/** The server root: /props sits beside /v1, not inside it. */
function propsUrl(baseUrl: string): string {
	const base = baseUrl.trim().replace(/\/+$/, '');
	return `${base.replace(/\/v\d+$/, '')}/props`;
}

/**
 * The levels quoted inside Jinja blocks that mention `reasoning_effort`.
 * Scoping it that way is what makes the count mean something: a level word
 * loose in the template — another kwarg's docs, a tool name, prose inside a
 * system-prompt string — is not a branch on the effort and must not count.
 */
function branchLevels(template: string): ReasoningEffort[] {
	const found = new Set<ReasoningEffort>();
	for (const block of template.match(JINJA_BLOCK) ?? []) {
		if (!/reasoning_effort/i.test(block)) continue;
		for (const level of TEMPLATE_LEVELS) {
			// Quoted, so Jinja's own `none` and the `max` filter don't count.
			if (new RegExp(`['"]${level}['"]`, 'i').test(block)) found.add(level);
		}
	}
	return TEMPLATE_LEVELS.filter((l) => found.has(l));
}

/** What a chat template says about the levels its model understands. */
export function effortSupportInTemplate(template: string): EffortSupport {
	// A mention anywhere counts, comments included: a template that documents
	// the parameter without branching on it is unreadable, not proof of
	// anything, and calling that "ignored" would take options away wrongly.
	if (!/reasoning_effort/i.test(template)) return { kind: 'ignored' };
	const levels = branchLevels(template);
	return levels.length >= MIN_LEVELS ? { kind: 'levels', levels } : { kind: 'unenumerated' };
}

/**
 * Ask the endpoint about its model. Anything that stops us reading the answer —
 * a server without /props, a refusal, a body we can't parse — comes back as
 * nothing established rather than as an empty answer.
 */
export function serverFacts(baseUrl: string, apiKey: string): Promise<ServerFacts> {
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
		.then((res): ServerFacts => {
			if (res.status >= 400) return NOTHING;
			const props = JSON.parse(res.text) as ServerProps;
			// A /props without a template is a server we can't read, not a
			// model that ignores the parameter.
			const template = props?.chat_template;
			const ctx = props?.n_ctx ?? props?.default_generation_settings?.n_ctx;
			return {
				effort:
					typeof template === 'string' && template
						? effortSupportInTemplate(template)
						: { kind: 'unknown' },
				contextSize: typeof ctx === 'number' && ctx > 0 ? ctx : null,
			};
		})
		.catch((e: unknown): ServerFacts => {
			// Endpoints that don't serve /props are the common case, not an error.
			console.debug('[vault-assistant] Nothing from', url, describeRequestError(e, url));
			return NOTHING;
		});

	cache.set(url, lookup);
	return lookup;
}

/** Forget what an endpoint said, so a model swap can be picked up. */
export function clearServerFacts(): void {
	cache.clear();
}
