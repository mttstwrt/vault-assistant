import { App } from 'obsidian';
import { VaultAssistantSettings } from './settings';
import { ChatMessage, ToolCall } from './types';
import { runAgent } from './agent';
import { buildResearchPrompt } from './prompts';
import { isResearchTool } from './tools/vault-tools';
import { McpManager } from './mcp/manager';
import { RagIndexer } from './rag/indexer';

/**
 * Context pre-pass: a research pass over the vault, run before the answer
 * starts, whose findings are injected into the answering thread's system
 * prompt.
 *
 * It is the same agent loop the conversation uses, scoped three ways: a short
 * history of its own, an allow-list of tools that only read, and a step budget.
 * The short history is the point. Discovery is what fills a small model's
 * context — listing folders, opening the wrong note, reading three pages to use
 * two lines — and all of it stays in the conversation for good. Here it happens
 * in a history that is thrown away, and only the handover crosses over.
 *
 * What crosses over is quoted, not summarised: the pass runs on the same model
 * that will answer, so a digest in its own words would buy compactness at the
 * price of a paraphrase nothing downstream could catch.
 */

const PRE_PASS_MARKER =
	'\n\n--- Pre-fetched context (a research pass over the vault ran before this message; the paths are notes it opened and the quotes are theirs, but it may have missed something or judged wrongly — verify with tools before relying on it) ---';

/** Cap on the injected block, so the pre-pass can't crowd out the conversation. */
const MAX_BLOCK_CHARS = 6000;

/** Remove a previous turn's pre-pass block from a system prompt. */
export function stripPrePass(systemContent: string): string {
	const i = systemContent.indexOf(PRE_PASS_MARKER);
	return i === -1 ? systemContent : systemContent.slice(0, i);
}

/** What the pre-pass reports while it runs, so the panel can show its work. */
export interface PrePassEvents {
	/** A new model call is starting; anything shown so far was a previous one. */
	onStep?: () => void;
	/** The model's reasoning, as it arrives, when it exposes any. */
	onReasoning?: (delta: string) => void;
	/** A note it is opening, or a search it is running. */
	onToolCall?: (call: ToolCall) => void;
	onToolResult?: (call: ToolCall, result: string) => void;
	/** What it handed over, or why it stopped without handing anything over. */
	onNote?: (text: string) => void;
}

/**
 * Research `userMessage` against the vault and return the context block for the
 * system prompt, or null when there is nothing worth adding. Never throws — a
 * failed pre-pass degrades to a normal turn.
 */
export async function prepareContext(
	app: App,
	settings: VaultAssistantSettings,
	saveSettings: () => Promise<void>,
	mcp: McpManager,
	rag: RagIndexer,
	userMessage: string,
	events: PrePassEvents = {},
	signal?: AbortSignal,
): Promise<string | null> {
	const history: ChatMessage[] = [
		{ role: 'system', content: await buildResearchPrompt(app, settings) },
		{ role: 'user', content: userMessage },
	];

	// Reasoning that arrives before a closing tag is classified as content, so
	// it is held rather than dropped until the stream says which it was.
	let held = '';

	try {
		await runAgent(
			app,
			settings,
			saveSettings,
			mcp,
			rag,
			new Set(), // a research pass never writes, so it holds no approvals
			new Set(),
			history,
			{
				// The handover is read off the history once the loop ends, so
				// there is nothing to do with a turn as it completes.
				onAssistant: () => undefined,
				onToolCall: (call) => events.onToolCall?.(call),
				onToolResult: (call, result) => events.onToolResult?.(call, result),
				onError: (message) => events.onNote?.(message),
				// Nothing that writes is offered, so nothing should ask. If
				// something finds a way to, the pre-pass is the wrong moment to
				// interrupt someone who is waiting for an answer.
				requestApproval: () => Promise.resolve('deny' as const),
				stream: {
					onStart: () => {
						held = '';
						events.onStep?.();
					},
					onContent: (delta) => {
						held += delta;
					},
					onReasoning: (delta) => events.onReasoning?.(delta),
					onReclassify: () => {
						events.onReasoning?.(held);
						held = '';
					},
					onDone: () => undefined,
				},
			},
			{
				toolFilter: isResearchTool,
				maxSteps: Math.max(1, settings.prePassSteps),
				signal,
			},
		);
	} catch (e) {
		console.warn('[vault-assistant] pre-pass failed:', e);
		return null;
	}

	if (signal?.aborted) return null;

	const handover = finalMessage(history);
	if (!handover) {
		// Every step went on tool calls and the budget ran out before anything
		// was written up. The loop has already said so; this is what to do
		// about it, since the budget is a setting.
		events.onNote?.(
			`No context was collected. Raise “Research steps” (currently ${settings.prePassSteps}) if the pass keeps running out.`,
		);
		return null;
	}

	events.onNote?.(handoverNote(handover));
	const block =
		handover.length > MAX_BLOCK_CHARS
			? handover.slice(0, MAX_BLOCK_CHARS) + '\n…(truncated)'
			: handover;
	return `${PRE_PASS_MARKER}\n${block}`;
}

/**
 * The pass's handover: the last thing it said without also calling a tool.
 * Anything earlier was said on the way to a tool call, not as a conclusion.
 */
function finalMessage(history: ChatMessage[]): string {
	for (let i = history.length - 1; i >= 0; i--) {
		const m = history[i];
		if (m?.role === 'assistant' && !m.toolCalls?.length && m.content.trim()) {
			return m.content.trim();
		}
	}
	return '';
}

/**
 * Name what crossed over, so it can be seen without opening the prompt. The
 * paths are read a line at a time, the way the handover is asked to write them
 * — a pattern loose in the text would stop at the first space, and half a vault
 * has spaces in its filenames.
 */
function handoverNote(handover: string): string {
	const paths = [
		...new Set(
			handover
				.split('\n')
				.map((line) => line.replace(/^[-*•\s]+/, '').replace(/:\s*$/, '').trim())
				.filter((line) => /\.md$/i.test(line) && line.length < 200),
		),
	];
	const size = `${handover.length} characters`;
	if (!paths.length) return `Handed over ${size}`;
	return `Handed over ${size} from ${paths.length} note${paths.length === 1 ? '' : 's'}: ${paths.join(' · ')}`;
}
