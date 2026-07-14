import { requestUrl } from 'obsidian';
import { ChatMessage, ToolCall, ToolSpec } from '../types';
import { VaultAssistantSettings } from '../settings';

interface ApiToolCall {
	id: string;
	type: 'function';
	function: { name: string; arguments: string };
}

interface ChatCompletionResponse {
	choices?: Array<{
		message?: {
			content?: string | null;
			tool_calls?: ApiToolCall[];
		};
	}>;
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

/** Convert our internal message shape to the OpenAI chat schema. */
function toApiMessage(m: ChatMessage): Record<string, unknown> {
	if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
		return {
			role: 'assistant',
			content: m.content || null,
			tool_calls: m.toolCalls.map(
				(t): ApiToolCall => ({
					id: t.id,
					type: 'function',
					function: { name: t.name, arguments: t.arguments },
				}),
			),
		};
	}
	if (m.role === 'tool') {
		return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
	}
	return { role: m.role, content: m.content };
}

export interface LLMResult {
	content: string;
	toolCalls: ToolCall[];
}

/** Per-call sampling overrides (workflow steps set these; defaults come from settings). */
export interface CallOverrides {
	temperature?: number;
	model?: string;
}

/** Fields the extra-params passthrough may never clobber. */
const PROTECTED_BODY_KEYS = new Set(['model', 'messages', 'tools', 'tool_choice']);

/** Parse the extra-body-params setting; invalid JSON is ignored with a warning. */
function extraBodyParams(settings: VaultAssistantSettings): Record<string, unknown> {
	if (!settings.useExtraBodyParams || !settings.extraBodyParams.trim()) return {};
	try {
		const parsed: unknown = JSON.parse(settings.extraBodyParams);
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
			if (!PROTECTED_BODY_KEYS.has(k)) out[k] = v;
		}
		return out;
	} catch (e) {
		console.warn('[vault-assistant] Ignoring invalid extra request parameters:', e);
		return {};
	}
}

/**
 * One round-trip to an OpenAI-compatible /chat/completions endpoint.
 * Uses Obsidian's requestUrl so it works on mobile and bypasses CORS.
 */
export async function chatCompletion(
	settings: VaultAssistantSettings,
	messages: ChatMessage[],
	tools: ToolSpec[],
	overrides: CallOverrides = {},
): Promise<LLMResult> {
	const base = settings.baseUrl.replace(/\/+$/, '');
	if (!base) throw new Error('No model base URL configured. Set one in settings.');
	const url = `${base}/chat/completions`;

	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	if (settings.apiKey.trim()) headers['Authorization'] = `Bearer ${settings.apiKey.trim()}`;

	// Priority: per-call overrides > extra params > settings.
	const body: Record<string, unknown> = {
		temperature: settings.temperature,
		...extraBodyParams(settings),
		model: overrides.model ?? settings.model,
		messages: messages.map(toApiMessage),
	};
	if (overrides.temperature !== undefined) body.temperature = overrides.temperature;
	if (tools.length > 0) {
		body.tools = tools.map((t) => ({ type: 'function', function: t }));
		body.tool_choice = 'auto';
	}

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

	const content: string = typeof msg.content === 'string' ? msg.content : '';
	const rawCalls: ApiToolCall[] = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
	const toolCalls: ToolCall[] = rawCalls
		.filter((tc) => tc.function?.name)
		.map((tc) => ({
			id: tc.id,
			name: tc.function.name,
			arguments: tc.function.arguments || '{}',
		}));

	return { content, toolCalls };
}
