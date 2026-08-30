/**
 * Shared plumbing for the OpenAI-compatible chat endpoint: request shaping and
 * the wire types both the buffered ({@link ./client}) and streaming
 * ({@link ./stream}) calls decode.
 */
import { ChatMessage, ToolCall, ToolSpec } from '../types';
import { VaultAssistantSettings } from '../settings';

export interface ApiToolCall {
	id: string;
	type: 'function';
	function: { name: string; arguments: string };
}

export interface ApiUsage {
	prompt_tokens?: number;
	completion_tokens?: number;
}

/** llama.cpp reports per-request speeds alongside the usual usage block. */
export interface ApiTimings {
	predicted_n?: number;
	predicted_per_second?: number;
	/** Prompt tokens actually processed — the part not served from cache. */
	prompt_n?: number;
	prompt_per_second?: number;
	/** Prompt tokens reused from the KV cache, which prompt_n excludes. */
	cache_n?: number;
}

/** What the endpoint reported about a finished call, when it reports anything. */
export interface CallStats {
	promptTokens?: number;
	completionTokens?: number;
	/** Generation speed, when the endpoint reports it (llama.cpp does). */
	tokensPerSecond?: number;
	/** Wall-clock duration of the call, in milliseconds. */
	elapsedMs: number;
}

export interface LLMResult {
	content: string;
	/** The model's reasoning, when it exposes any. Never sent back to the model. */
	reasoning: string;
	toolCalls: ToolCall[];
	stats?: CallStats;
	/** True when the caller's signal aborted the call, so content is partial. */
	aborted?: boolean;
}

/** Per-call sampling overrides (workflow steps set these; defaults come from settings). */
export interface CallOverrides {
	temperature?: number;
	model?: string;
}

/** Fields the extra-params passthrough may never clobber. */
const PROTECTED_BODY_KEYS = new Set(['model', 'messages', 'tools', 'tool_choice', 'stream']);

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

/** The endpoint URL and headers for a chat call. */
export function chatEndpoint(settings: VaultAssistantSettings): {
	url: string;
	headers: Record<string, string>;
} {
	const base = settings.baseUrl.replace(/\/+$/, '');
	if (!base) throw new Error('No model base URL configured. Set one in settings.');
	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	if (settings.apiKey.trim()) headers['Authorization'] = `Bearer ${settings.apiKey.trim()}`;
	return { url: `${base}/chat/completions`, headers };
}

/** The request body for a chat call. Priority: per-call overrides > extra params > settings. */
export function chatRequestBody(
	settings: VaultAssistantSettings,
	messages: ChatMessage[],
	tools: ToolSpec[],
	overrides: CallOverrides,
	stream: boolean,
): Record<string, unknown> {
	const body: Record<string, unknown> = {
		temperature: settings.temperature,
		...extraBodyParams(settings),
		model: overrides.model ?? settings.model,
		messages: messages.map(toApiMessage),
	};
	if (overrides.temperature !== undefined) body.temperature = overrides.temperature;

	// Sampler controls are only sent when set away from their defaults: an
	// endpoint that rejects a parameter it doesn't know should never see one
	// the user didn't ask for.
	if (settings.presencePenalty !== 0) body.presence_penalty = settings.presencePenalty;
	if (settings.repetitionPenalty !== 1) {
		// The same sampler under two names: llama.cpp calls it repeat_penalty,
		// vLLM and TGI call it repetition_penalty. Servers ignore the other one.
		body.repeat_penalty = settings.repetitionPenalty;
		body.repetition_penalty = settings.repetitionPenalty;
	}

	if (tools.length > 0) {
		body.tools = tools.map((t) => ({ type: 'function', function: t }));
		body.tool_choice = 'auto';
	}
	if (stream) body.stream = true;
	return body;
}

/**
 * The whole prompt the model read, not just the part the server had to work
 * through. `usage.prompt_tokens` already counts both; llama.cpp's timings
 * split them, and on every turn after the first the reused prefix is nearly
 * all of it — so `prompt_n` alone would report a few dozen tokens for a
 * conversation of thousands. Its own docs give the sum as the context in use.
 */
function promptTokens(usage?: ApiUsage, timings?: ApiTimings): number | undefined {
	if (usage?.prompt_tokens !== undefined) return usage.prompt_tokens;
	if (timings?.prompt_n === undefined && timings?.cache_n === undefined) return undefined;
	return (timings.prompt_n ?? 0) + (timings.cache_n ?? 0);
}

/** Normalise the usage/timings an endpoint reports into our stats shape. */
export function toStats(
	usage: ApiUsage | undefined,
	timings: ApiTimings | undefined,
	elapsedMs: number,
): CallStats {
	const completionTokens = usage?.completion_tokens ?? timings?.predicted_n;
	const perSecond =
		timings?.predicted_per_second ??
		(completionTokens && elapsedMs > 0 ? (completionTokens * 1000) / elapsedMs : undefined);
	return {
		promptTokens: promptTokens(usage, timings),
		completionTokens,
		tokensPerSecond: perSecond,
		elapsedMs,
	};
}

/** Drop malformed calls and normalise the rest. */
export function toToolCalls(raw: ApiToolCall[]): ToolCall[] {
	return raw
		.filter((tc) => tc.function?.name)
		.map((tc) => ({
			id: tc.id,
			name: tc.function.name,
			arguments: tc.function.arguments || '{}',
		}));
}
