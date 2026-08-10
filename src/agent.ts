import { App } from 'obsidian';
import { VaultAssistantSettings } from './settings';
import { ApprovalRequest, ApprovalResult, ChatMessage, ToolCall, ToolSpec } from './types';
import { CallOverrides, CallStats, LLMResult, chatCompletion } from './api/client';
import { streamChatCompletion } from './api/stream';
import { ToolContext, activeToolSpecs, executeTool } from './tools/vault-tools';
import { McpManager } from './mcp/manager';
import { RagIndexer } from './rag/indexer';

/** How a streamed turn is reported to the UI while it is being generated. */
export interface StreamEvents {
	/** A new model turn is starting; nothing has arrived yet. */
	onStart(): void;
	onContent(delta: string): void;
	onReasoning(delta: string): void;
	/** Everything shown as content so far was reasoning after all. */
	onReclassify(): void;
	/** The turn ended, was interrupted, or failed. */
	onDone(info: { stats?: CallStats; aborted: boolean }): void;
}

export interface AgentEvents {
	onAssistant(content: string): void;
	onToolCall(call: ToolCall): void;
	onToolResult(call: ToolCall, result: string): void;
	onError(message: string): void;
	/** Ask the user to approve a write outside the allowed folders. */
	requestApproval: (req: ApprovalRequest) => Promise<ApprovalResult>;
	/**
	 * Render turns as they stream. When provided (and streaming is enabled in
	 * settings) assistant content is reported here instead of onAssistant.
	 */
	stream?: StreamEvents;
}

/** A run-scoped tool (e.g. finish_research) offered alongside the built-ins. */
export interface ExtraTool {
	spec: ToolSpec;
	run: (argsJson: string) => Promise<string>;
}

export interface AgentOptions {
	extraTools?: ExtraTool[];
	/** Checked before each model call, so a stop takes effect mid-run. */
	shouldStop?: () => boolean;
	/** Restrict the built-in/MCP tools offered (extra tools are always offered). */
	toolFilter?: (name: string) => boolean;
	/** Cap on tool-call rounds for this run; falls back to settings.maxSteps. */
	maxSteps?: number;
	/** Per-run sampling overrides (workflow steps set temperature/model here). */
	overrides?: CallOverrides;
	/** Cuts a streamed answer off mid-generation (the panel's Stop / Ctrl+C). */
	signal?: AbortSignal;
}

/**
 * Drive the agentic loop: call the model, run any tools it requests, feed the
 * results back, and repeat until it answers or hits the step limit. Mutates
 * and returns `history`.
 */
export async function runAgent(
	app: App,
	settings: VaultAssistantSettings,
	saveSettings: () => Promise<void>,
	mcp: McpManager,
	rag: RagIndexer,
	sessionWrites: Set<string>,
	sessionMcp: Set<string>,
	history: ChatMessage[],
	events: AgentEvents,
	opts: AgentOptions = {},
): Promise<ChatMessage[]> {
	const ctx: ToolContext = {
		app,
		settings,
		saveSettings,
		sessionWrites,
		sessionMcp,
		mcp,
		rag,
		requestApproval: events.requestApproval,
	};
	const extraTools = new Map((opts.extraTools ?? []).map((t) => [t.spec.name, t]));
	const allow = opts.toolFilter ?? (() => true);
	const tools = [
		...activeToolSpecs(settings).filter((t) => allow(t.name)),
		...[...extraTools.values()].map((t) => t.spec),
		...mcp.toolSpecs().filter((t) => allow(t.name)),
	];
	const maxSteps = opts.maxSteps ?? settings.maxSteps;
	const stream = settings.streamResponses ? events.stream : undefined;

	/** One model turn, streamed when possible, buffered when that fails. */
	const callModel = async (): Promise<LLMResult> => {
		if (!stream) return chatCompletion(settings, history, tools, opts.overrides ?? {});
		let arrived = false;
		try {
			return await streamChatCompletion(
				settings,
				history,
				tools,
				opts.overrides ?? {},
				{
					onContent: (d) => {
						arrived = true;
						stream.onContent(d);
					},
					onReasoning: (d) => {
						arrived = true;
						stream.onReasoning(d);
					},
					onReclassify: () => stream.onReclassify(),
				},
				opts.signal,
			);
		} catch (e) {
			// Nothing arrived and the user didn't stop it: the endpoint may not
			// support streaming from here (CORS, a proxy) — try the buffered path
			// once, then let any error surface normally.
			if (arrived || opts.signal?.aborted) throw e;
			console.warn('[vault-assistant] Streaming failed; retrying without it:', e);
			const res = await chatCompletion(settings, history, tools, opts.overrides ?? {});
			if (res.reasoning) stream.onReasoning(res.reasoning);
			if (res.content) stream.onContent(res.content);
			return res;
		}
	};

	for (let step = 0; step < maxSteps; step++) {
		if (opts.shouldStop?.() || opts.signal?.aborted) return history;

		let result: LLMResult;
		stream?.onStart();
		try {
			result = await callModel();
		} catch (e) {
			stream?.onDone({ aborted: !!opts.signal?.aborted });
			if (opts.signal?.aborted) return history;
			events.onError(e instanceof Error ? e.message : String(e));
			return history;
		}
		stream?.onDone({ stats: result.stats, aborted: !!result.aborted });

		if (result.aborted) {
			// Keep the partial answer as context, but drop any half-formed tool
			// calls: an assistant turn with calls needs a result for every one.
			if (result.content.trim()) history.push({ role: 'assistant', content: result.content });
			return history;
		}

		history.push({
			role: 'assistant',
			content: result.content,
			toolCalls: result.toolCalls.length ? result.toolCalls : undefined,
		});

		if (!stream && result.content) events.onAssistant(result.content);

		if (result.toolCalls.length === 0) return history;

		for (const call of result.toolCalls) {
			// An interruption still needs a result per call, or the next request
			// would be rejected for an unanswered tool call.
			if (opts.signal?.aborted) {
				history.push({ role: 'tool', toolCallId: call.id, content: 'Interrupted by the user.' });
				continue;
			}
			events.onToolCall(call);
			const extra = extraTools.get(call.name);
			const out = extra
				? await extra.run(call.arguments)
				: await executeTool(ctx, call.name, call.arguments);
			events.onToolResult(call, out);
			history.push({ role: 'tool', toolCallId: call.id, content: out });
		}
		if (opts.signal?.aborted) return history;
	}

	events.onError(`Reached the maximum of ${maxSteps} tool steps without a final answer.`);
	return history;
}
