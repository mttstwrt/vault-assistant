import { App } from 'obsidian';
import { VaultAssistantSettings } from './settings';
import { ApprovalRequest, ApprovalResult, ChatMessage, ToolCall, ToolSpec } from './types';
import { CallOverrides, chatCompletion } from './api/client';
import { ToolContext, activeToolSpecs, executeTool } from './tools/vault-tools';
import { McpManager } from './mcp/manager';
import { RagIndexer } from './rag/indexer';
import { isStopped, untilStopped } from './stop';

export interface AgentEvents {
	onAssistant(content: string): void;
	onToolCall(call: ToolCall): void;
	onToolResult(call: ToolCall, result: string): void;
	onError(message: string): void;
	/** Ask the user to approve a write outside the allowed folders. */
	requestApproval: (req: ApprovalRequest) => Promise<ApprovalResult>;
}

/** A run-scoped tool (e.g. finish_research) offered alongside the built-ins. */
export interface ExtraTool {
	spec: ToolSpec;
	run: (argsJson: string) => Promise<string>;
}

export interface AgentOptions {
	extraTools?: ExtraTool[];
	/**
	 * Stops the run: the model call in flight is abandoned, no further calls or
	 * tools are started, and the loop returns at the next boundary.
	 */
	signal?: AbortSignal;
	/** Restrict the built-in/MCP tools offered (extra tools are always offered). */
	toolFilter?: (name: string) => boolean;
	/** Cap on tool-call rounds for this run; falls back to settings.maxSteps. */
	maxSteps?: number;
	/** Per-run sampling overrides (workflow steps set temperature/model here). */
	overrides?: CallOverrides;
}

/** Stand-in result for a tool call the stop cut short before it ran. */
const STOPPED_TOOL_RESULT = 'Stopped by the user before this tool ran.';

/**
 * Drive the agentic loop: call the model, run any tools it requests, feed the
 * results back, and repeat until it answers or hits the step limit. Mutates
 * and returns `history`.
 *
 * A stop leaves `history` in a state the API still accepts, so the
 * conversation can simply carry on with the user's next message.
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
	const signal = opts.signal;

	for (let step = 0; step < maxSteps; step++) {
		if (signal?.aborted) return history;
		let result;
		try {
			result = await untilStopped(
				chatCompletion(settings, history, tools, opts.overrides ?? {}),
				signal,
			);
		} catch (e) {
			// A stop is a choice, not a failure — leave the turn unreported.
			if (!isStopped(e)) events.onError(e instanceof Error ? e.message : String(e));
			return history;
		}

		history.push({
			role: 'assistant',
			content: result.content,
			toolCalls: result.toolCalls.length ? result.toolCalls : undefined,
		});

		if (result.content) events.onAssistant(result.content);

		if (result.toolCalls.length === 0) return history;

		for (const call of result.toolCalls) {
			if (signal?.aborted) {
				// The API rejects an assistant turn whose tool calls have no
				// results, so close the abandoned ones off rather than leaving
				// history unusable for the next message.
				history.push({ role: 'tool', toolCallId: call.id, content: STOPPED_TOOL_RESULT });
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

		if (signal?.aborted) return history;
	}

	events.onError(`Reached the maximum of ${maxSteps} tool steps without a final answer.`);
	return history;
}
