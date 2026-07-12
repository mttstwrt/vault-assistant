import { App } from 'obsidian';
import { VaultAssistantSettings } from './settings';
import { ApprovalRequest, ApprovalResult, ChatMessage, ToolCall } from './types';
import { chatCompletion } from './api/client';
import { ToolContext, activeToolSpecs, executeTool } from './tools/vault-tools';
import { McpManager } from './mcp/manager';
import { RagIndexer } from './rag/indexer';

export interface AgentEvents {
	onAssistant(content: string): void;
	onToolCall(call: ToolCall): void;
	onToolResult(call: ToolCall, result: string): void;
	onError(message: string): void;
	/** Ask the user to approve a write outside the allowed folders. */
	requestApproval: (req: ApprovalRequest) => Promise<ApprovalResult>;
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
	const tools = [...activeToolSpecs(settings), ...mcp.toolSpecs()];

	for (let step = 0; step < settings.maxSteps; step++) {
		let result;
		try {
			result = await chatCompletion(settings, history, tools);
		} catch (e) {
			events.onError(e instanceof Error ? e.message : String(e));
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
			events.onToolCall(call);
			const out = await executeTool(ctx, call.name, call.arguments);
			events.onToolResult(call, out);
			history.push({ role: 'tool', toolCallId: call.id, content: out });
		}
	}

	events.onError(`Reached the maximum of ${settings.maxSteps} tool steps without a final answer.`);
	return history;
}
