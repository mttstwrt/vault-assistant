import { requestUrl } from 'obsidian';
import { ChatMessage, ToolSpec } from '../types';
import { VaultAssistantSettings } from '../settings';
import { splitThinkTags } from './reasoning';
import {
	ApiTimings,
	ApiToolCall,
	ApiUsage,
	CallOverrides,
	LLMResult,
	chatEndpoint,
	chatRequestBody,
	toStats,
	toToolCalls,
} from './request';

export type { CallOverrides, CallStats, LLMResult } from './request';

interface ChatCompletionResponse {
	choices?: Array<{
		message?: {
			content?: string | null;
			/** llama.cpp / DeepSeek / OpenRouter reasoning channel. */
			reasoning_content?: string | null;
			reasoning?: string | null;
			tool_calls?: ApiToolCall[];
		};
	}>;
	usage?: ApiUsage;
	timings?: ApiTimings;
}

interface EmbeddingsResponse {
	data?: Array<{ embedding?: number[]; index?: number }>;
}

/**
 * Embed a batch of texts via an OpenAI-compatible /embeddings endpoint
 * (Ollama, LM Studio, and OpenAI all expose one). Defaults to the chat
 * endpoint/key; embedBaseUrl/embedApiKey override them for split setups.
 */
export async function embed(
	settings: VaultAssistantSettings,
	texts: string[],
): Promise<number[][]> {
	const base = (settings.embedBaseUrl.trim() || settings.baseUrl).replace(/\/+$/, '');
	if (!base) throw new Error('No embeddings base URL configured. Set one in settings.');
	const model = settings.embedModel.trim();
	if (!model) throw new Error('No embedding model configured. Set one in settings.');

	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	const key = settings.embedApiKey.trim() || settings.apiKey.trim();
	if (key) headers['Authorization'] = `Bearer ${key}`;

	const res = await requestUrl({
		url: `${base}/embeddings`,
		method: 'POST',
		headers,
		body: JSON.stringify({ model, input: texts }),
		throw: false,
	});

	if (res.status >= 400) {
		const detail = (res.text ?? '').slice(0, 300);
		throw new Error(`Embeddings API error ${res.status}: ${detail}`);
	}

	const data = (res.json as EmbeddingsResponse)?.data;
	if (!Array.isArray(data) || data.length !== texts.length) {
		throw new Error(
			`Embeddings API returned ${Array.isArray(data) ? data.length : 0} vectors for ${texts.length} inputs.`,
		);
	}
	return [...data]
		.sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
		.map((d) => {
			if (!Array.isArray(d.embedding) || !d.embedding.length) {
				throw new Error('Embeddings API returned an empty embedding.');
			}
			return d.embedding;
		});
}

/**
 * One buffered round-trip to an OpenAI-compatible /chat/completions endpoint.
 * Uses Obsidian's requestUrl so it works on mobile and bypasses CORS; the
 * streaming counterpart lives in ./stream.
 */
export async function chatCompletion(
	settings: VaultAssistantSettings,
	messages: ChatMessage[],
	tools: ToolSpec[],
	overrides: CallOverrides = {},
): Promise<LLMResult> {
	const { url, headers } = chatEndpoint(settings);
	const body = chatRequestBody(settings, messages, tools, overrides, false);
	const startedAt = Date.now();

	const res = await requestUrl({
		url,
		method: 'POST',
		headers,
		body: JSON.stringify(body),
		throw: false,
	});

	if (res.status >= 400) {
		const detail = (res.text ?? '').slice(0, 500);
		throw new Error(`API error ${res.status}: ${detail}`);
	}

	const json = res.json as ChatCompletionResponse;
	const msg = json?.choices?.[0]?.message;
	if (!msg) {
		throw new Error('Unexpected API response: no message returned.');
	}

	const raw: string = typeof msg.content === 'string' ? msg.content : '';
	const channel = msg.reasoning_content ?? msg.reasoning;
	// A server-provided reasoning channel wins; otherwise look for <think> tags.
	const split =
		typeof channel === 'string' && channel
			? { content: raw, reasoning: channel }
			: splitThinkTags(raw);

	return {
		content: split.content,
		reasoning: split.reasoning,
		toolCalls: toToolCalls(Array.isArray(msg.tool_calls) ? msg.tool_calls : []),
		stats: toStats(json.usage, json.timings, Date.now() - startedAt),
	};
}
