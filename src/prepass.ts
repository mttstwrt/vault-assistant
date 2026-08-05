import { App } from 'obsidian';
import { VaultAssistantSettings } from './settings';
import { chatCompletion } from './api/client';
import { RagIndexer } from './rag/indexer';
import { isReadable } from './permissions';
import { isStopped, untilStopped } from './stop';

/**
 * Context pre-pass: before answering, expand the user's message into a few
 * search queries with a cheap model call, run them against the vault, and
 * inject the top hits into the system prompt. Aimed at small local models,
 * which flail on tool selection — pre-fetched grounding cuts tool rounds.
 */

const PRE_PASS_MARKER =
	'\n\n--- Pre-fetched context (from a preliminary vault search; may be irrelevant — verify with tools before relying on it) ---';

/** Cap on the injected block, so the pre-pass can't crowd out the conversation. */
const MAX_BLOCK_CHARS = 6000;

/** Remove a previous turn's pre-pass block from a system prompt. */
export function stripPrePass(systemContent: string): string {
	const i = systemContent.indexOf(PRE_PASS_MARKER);
	return i === -1 ? systemContent : systemContent.slice(0, i);
}

/**
 * Build the pre-pass context block for `userMessage`, or null when nothing
 * useful was found. Never throws — a failed or stopped pre-pass degrades to a
 * normal turn.
 */
export async function prepareContext(
	app: App,
	settings: VaultAssistantSettings,
	rag: RagIndexer,
	userMessage: string,
	signal?: AbortSignal,
): Promise<string | null> {
	let queries: string[];
	try {
		queries = await untilStopped(extractQueries(settings, userMessage), signal);
	} catch (e) {
		if (!isStopped(e)) console.warn('[vault-assistant] pre-pass query extraction failed:', e);
		return null;
	}
	if (queries.length === 0) return null;

	const sections: string[] = [];
	for (const q of queries.slice(0, 4)) {
		if (signal?.aborted) return null;
		let hits = '';
		if (settings.useRag) {
			try {
				hits = await rag.search(q, Math.min(settings.ragTopK, 4));
			} catch (e) {
				console.warn('[vault-assistant] pre-pass semantic search failed:', e);
			}
			// Index problems come back as prose, not hits — fall through to literal.
			if (!hits.includes(': …')) hits = '';
		}
		if (!hits) hits = await literalSearch(app, settings, q, 4);
		if (hits) sections.push(`Search "${q}":\n${hits}`);
	}
	if (sections.length === 0) return null;

	let block = sections.join('\n\n');
	if (block.length > MAX_BLOCK_CHARS) block = block.slice(0, MAX_BLOCK_CHARS) + '\n…(truncated)';
	return `${PRE_PASS_MARKER}\n${block}`;
}

/** One cheap, tool-less model call: user message → 2–4 short search queries. */
async function extractQueries(
	settings: VaultAssistantSettings,
	userMessage: string,
): Promise<string[]> {
	const result = await chatCompletion(
		settings,
		[
			{
				role: 'system',
				content:
					'You turn a user request into search queries over their personal Obsidian vault. ' +
					'Reply with ONLY a JSON array of 2 to 4 short search queries (plain strings) that would ' +
					'surface notes relevant to the request. Use the user\'s own likely wording, not questions. ' +
					'No commentary, no code fences.',
			},
			{ role: 'user', content: userMessage },
		],
		[],
		{ temperature: 0.1 },
	);

	const text = result.content;
	const start = text.indexOf('[');
	const end = text.lastIndexOf(']');
	if (start === -1 || end <= start) return [];
	const parsed: unknown = JSON.parse(text.slice(start, end + 1));
	if (!Array.isArray(parsed)) return [];
	return parsed.filter((q): q is string => typeof q === 'string' && q.trim().length > 0);
}

/** Case-insensitive substring scan, same shape as the `search` tool's results. */
async function literalSearch(
	app: App,
	settings: VaultAssistantSettings,
	query: string,
	limit: number,
): Promise<string> {
	const q = query.toLowerCase();
	const results: string[] = [];
	for (const file of app.vault.getMarkdownFiles()) {
		if (!isReadable(file.path, settings)) continue;
		const text = await app.vault.cachedRead(file);
		const idx = text.toLowerCase().indexOf(q);
		if (idx >= 0) {
			const snippet = text
				.slice(Math.max(0, idx - 40), idx + 80)
				.replace(/\s+/g, ' ')
				.trim();
			results.push(`${file.path}: …${snippet}…`);
			if (results.length >= limit) break;
		}
	}
	return results.join('\n');
}
