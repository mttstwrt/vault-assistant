/**
 * Streaming chat completions (server-sent events), so answers appear token by
 * token, reasoning can be shown as it happens, and a request can be cut off
 * mid-answer.
 *
 * This is the one place the plugin uses `fetch` instead of Obsidian's
 * `requestUrl`: requestUrl buffers the whole response, so it cannot stream and
 * cannot be aborted. Local endpoints (llama.cpp, Ollama, LM Studio) allow the
 * Obsidian app origin; when a request cannot be made this way at all, the agent
 * falls back to the buffered call in ./client.
 */
import { ChatMessage, ToolCall, ToolSpec } from '../types';
import { VaultAssistantSettings } from '../settings';
import { ThinkTagSplitter } from './reasoning';
import {
	ApiTimings,
	ApiUsage,
	CallOverrides,
	LLMResult,
	chatEndpoint,
	chatRequestBody,
	toStats,
} from './request';

/** A `tool_calls` entry inside a streamed delta; fields arrive piecemeal. */
interface DeltaToolCall {
	index?: number;
	id?: string;
	function?: { name?: string; arguments?: string };
}

interface StreamChunk {
	choices?: Array<{
		delta?: {
			content?: string | null;
			reasoning_content?: string | null;
			reasoning?: string | null;
			tool_calls?: DeltaToolCall[];
		};
	}>;
	usage?: ApiUsage;
	timings?: ApiTimings;
}

/** Live output from a streaming call, in the order it must be applied. */
export interface StreamHandlers {
	onContent(delta: string): void;
	onReasoning(delta: string): void;
	/**
	 * Everything reported as content so far was actually reasoning — a closing
	 * `</think>` arrived without an opener. See {@link ThinkTagSplitter}.
	 */
	onReclassify(): void;
}

/** Accumulates the pieces of one streamed tool call. */
interface PartialToolCall {
	id: string;
	name: string;
	arguments: string;
}

/**
 * Stream one turn from an OpenAI-compatible /chat/completions endpoint,
 * reporting deltas as they arrive and returning the assembled turn.
 *
 * When `signal` aborts, whatever arrived so far is returned with
 * `aborted: true` instead of throwing — partial answers are kept.
 */
export async function streamChatCompletion(
	settings: VaultAssistantSettings,
	messages: ChatMessage[],
	tools: ToolSpec[],
	overrides: CallOverrides,
	handlers: StreamHandlers,
	signal?: AbortSignal,
): Promise<LLMResult> {
	const { url, headers } = chatEndpoint(settings);
	const body = chatRequestBody(settings, messages, tools, overrides, true);
	const startedAt = Date.now();

	const res = await fetch(url, {
		method: 'POST',
		headers: { ...headers, Accept: 'text/event-stream' },
		body: JSON.stringify(body),
		signal,
	});

	if (!res.ok) {
		const detail = (await res.text().catch(() => '')).slice(0, 500);
		throw new Error(`API error ${res.status}: ${detail}`);
	}
	if (!res.body) throw new Error('The endpoint returned no response body to stream.');

	const splitter = new ThinkTagSplitter();
	const calls = new Map<number, PartialToolCall>();
	let content = '';
	let reasoning = '';
	let usage: ApiUsage | undefined;
	let timings: ApiTimings | undefined;
	let aborted = false;

	/** Route a content delta through the <think> splitter, then to the UI. */
	const emitContent = (text: string): void => {
		const part = splitter.push(text);
		if (part.reclassifyPrior) {
			reasoning = content + reasoning;
			content = '';
			handlers.onReclassify();
		}
		if (part.reasoning) {
			reasoning += part.reasoning;
			handlers.onReasoning(part.reasoning);
		}
		if (part.content) {
			content += part.content;
			handlers.onContent(part.content);
		}
	};

	const emitReasoning = (text: string): void => {
		reasoning += text;
		handlers.onReasoning(text);
	};

	const handleChunk = (chunk: StreamChunk): void => {
		if (chunk.usage) usage = chunk.usage;
		if (chunk.timings) timings = chunk.timings;
		const delta = chunk.choices?.[0]?.delta;
		if (!delta) return;

		const channel = delta.reasoning_content ?? delta.reasoning;
		if (typeof channel === 'string' && channel) emitReasoning(channel);
		if (typeof delta.content === 'string' && delta.content) emitContent(delta.content);

		for (const [i, tc] of (delta.tool_calls ?? []).entries()) {
			const index = tc.index ?? i;
			const partial = calls.get(index) ?? { id: '', name: '', arguments: '' };
			if (tc.id) partial.id = tc.id;
			if (tc.function?.name) partial.name = tc.function.name;
			if (tc.function?.arguments) partial.arguments += tc.function.arguments;
			calls.set(index, partial);
		}
	};

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buf = '';
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });

			// SSE events are separated by a blank line; a line may be split
			// across reads, so only complete events are consumed here.
			let cut = buf.indexOf('\n\n');
			while (cut !== -1) {
				const event = buf.slice(0, cut);
				buf = buf.slice(cut + 2);
				if (readEvent(event, handleChunk)) return finish();
				cut = buf.indexOf('\n\n');
			}
		}
		// Some endpoints end the stream without a trailing blank line.
		if (buf.trim()) readEvent(buf, handleChunk);
	} catch (e) {
		if (!isAbort(e, signal)) throw e;
		aborted = true;
	} finally {
		await reader.cancel().catch(() => undefined);
	}

	return finish();

	function finish(): LLMResult {
		const rest = splitter.flush();
		if (rest.reasoning) emitReasoning(rest.reasoning);
		if (rest.content) {
			content += rest.content;
			handlers.onContent(rest.content);
		}
		const toolCalls: ToolCall[] = [...calls.entries()]
			.sort((a, b) => a[0] - b[0])
			.map(([, c]) => c)
			.filter((c) => c.name)
			.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments || '{}' }));
		return {
			content,
			reasoning,
			toolCalls,
			stats: toStats(usage, timings, Date.now() - startedAt),
			aborted: aborted || signal?.aborted === true,
		};
	}
}

/**
 * Decode one SSE event and hand its payload to `onChunk`.
 * Returns true when the event is the stream terminator.
 */
function readEvent(event: string, onChunk: (chunk: StreamChunk) => void): boolean {
	for (const line of event.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith(':')) continue;
		if (!trimmed.startsWith('data:')) continue;
		const payload = trimmed.slice(5).trim();
		if (!payload) continue;
		if (payload === '[DONE]') return true;
		try {
			onChunk(JSON.parse(payload) as StreamChunk);
		} catch (e) {
			console.warn('[vault-assistant] Skipping unparsable stream chunk:', payload, e);
		}
	}
	return false;
}

/** Distinguish "the user stopped it" from a real transport failure. */
function isAbort(e: unknown, signal?: AbortSignal): boolean {
	return signal?.aborted === true || (e instanceof DOMException && e.name === 'AbortError');
}
