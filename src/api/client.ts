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

/**
 * One round-trip to an OpenAI-compatible /chat/completions endpoint.
 * Uses Obsidian's requestUrl so it works on mobile and bypasses CORS.
 */
export async function chatCompletion(
	settings: VaultAssistantSettings,
	messages: ChatMessage[],
	tools: ToolSpec[],
): Promise<LLMResult> {
	const base = settings.baseUrl.replace(/\/+$/, '');
	if (!base) throw new Error('No model base URL configured. Set one in settings.');
	const url = `${base}/chat/completions`;

	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	if (settings.apiKey.trim()) headers['Authorization'] = `Bearer ${settings.apiKey.trim()}`;

	const body: Record<string, unknown> = {
		model: settings.model,
		messages: messages.map(toApiMessage),
		temperature: settings.temperature,
	};
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
