import { App } from 'obsidian';
import { VaultAssistantSettings } from './settings';
import { ChatMessage, ToolCall } from './types';
import { ExtraTool, runAgent } from './agent';
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
 *
 * Most messages need none of this. A conversation is mostly follow-ups, and a
 * pass that runs anyway is a wait before every answer, so deciding not to
 * research is the pass's first job and its cheapest outcome: one generation
 * that calls `no_research_needed` and stops. To make that decision it is shown
 * the last few turns and what the previous pass collected — without them, "do
 * we already have this?" is not a question the message alone can answer.
 */

const PRE_PASS_MARKER =
	'\n\n--- Pre-fetched context (a research pass over the vault ran before this message; the paths are notes it opened and the quotes are theirs, but it may have missed something or judged wrongly — verify with tools before relying on it) ---';

/** Cap on the injected block, so the pre-pass can't crowd out the conversation. */
const MAX_BLOCK_CHARS = 6000;

/** Turns of conversation the pass is shown, so it can recognise a follow-up. */
const RECENT_MESSAGES = 4;
/** Per-message caps on that excerpt: enough to recognise, not to re-read. */
const CLIP_USER = 600;
const CLIP_ASSISTANT = 400;
/** Enough of the last handover to see which notes it already covered. */
const CLIP_HANDOVER = 1000;

/**
 * What a model with no working tool call says instead of calling
 * `no_research_needed`. Both are accepted: small models split about evenly on
 * which of the two they can do reliably.
 */
const SKIP_SENTINEL = 'NO_CONTEXT_NEEDED';

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

/** What the pass is shown besides the message itself, to decide on skipping. */
export interface PrePassContext {
	/** The conversation before this message, newest last. Tool turns and all. */
	recent?: ChatMessage[];
	/** The block the last pass collected, which the answer still carries. */
	previousHandover?: string;
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
	context: PrePassContext = {},
	events: PrePassEvents = {},
	signal?: AbortSignal,
): Promise<string | null> {
	const history: ChatMessage[] = [
		{ role: 'system', content: await buildResearchPrompt(app, settings) },
		{ role: 'user', content: researchRequest(userMessage, context) },
	];

	/** Set by the skip tool: why the pass decided the vault wasn't needed. */
	let skipped: string | null = null;

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
				extraTools: [skipTool((reason) => (skipped = reason))],
				// Checked before each model call, so calling the skip tool ends
				// the pass on the generation that called it rather than paying
				// for another one to say nothing.
				shouldStop: () => skipped !== null,
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
	// A model that can't call the tool says so in words instead.
	if (skipped === null && handover.startsWith(SKIP_SENTINEL)) {
		skipped = handover.slice(SKIP_SENTINEL.length).replace(/^[\s:.—-]+/, '').trim();
	}
	if (skipped !== null) {
		events.onNote?.(skipped ? `No new context needed — ${skipped}` : 'No new context needed.');
		return null;
	}

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
 * The way out. Offered as a tool because the model is already holding tools,
 * and a tool call is the one thing every tool-trained model can be relied on
 * to emit; the sentinel in the prompt covers the ones that can't.
 */
function skipTool(onSkip: (reason: string) => void): ExtraTool {
	return {
		spec: {
			name: 'no_research_needed',
			description:
				'End this research step without collecting anything, because the message does not need the vault: it is about the conversation itself, it is small talk or an instruction, or what it needs was already collected or already discussed. Call this instead of searching when that is so, and call nothing else.',
			parameters: {
				type: 'object',
				properties: {
					reason: {
						type: 'string',
						description: 'One short line: why the vault is not needed for this message.',
					},
				},
				required: ['reason'],
			},
		},
		run: (argsJson: string) => {
			let reason = '';
			try {
				const v = (JSON.parse(argsJson || '{}') as Record<string, unknown>).reason;
				if (typeof v === 'string') reason = v.trim();
			} catch {
				// A malformed argument still means the model chose to skip.
			}
			onSkip(reason);
			return Promise.resolve('Nothing collected; the answer will proceed without new context.');
		},
	};
}

/**
 * The message the pass researches, with what it needs to judge whether to
 * bother: the last few turns, and what the previous pass already handed over.
 * Both are clipped — they are here to be recognised, not re-read, and the
 * point of the pass is to not spend context on reading.
 */
function researchRequest(userMessage: string, context: PrePassContext): string {
	const parts: string[] = [];

	const recent = (context.recent ?? [])
		.filter((m) => m.role === 'user' || (m.role === 'assistant' && !m.toolCalls?.length))
		.filter((m) => m.content.trim())
		.slice(-RECENT_MESSAGES);
	if (recent.length) {
		parts.push(
			'--- The conversation so far (you are not answering it; it is here so you can tell a follow-up from a new subject) ---',
			recent
				.map(
					(m) =>
						`${m.role === 'user' ? 'User' : 'Assistant'}: ${clip(m.content, m.role === 'user' ? CLIP_USER : CLIP_ASSISTANT)}`,
				)
				.join('\n'),
		);
	}

	const previous = context.previousHandover?.trim();
	if (previous) {
		parts.push(
			'--- Already handed over by the last research pass, and still in front of the assistant ---',
			clip(previous, CLIP_HANDOVER),
		);
	}

	parts.push('--- The new message to decide on, and research if it needs it ---', userMessage);
	return parts.join('\n\n');
}

/** Cut to `max` characters on a word boundary where there is one nearby. */
function clip(text: string, max: number): string {
	const t = text.trim();
	if (t.length <= max) return t;
	const cut = t.slice(0, max);
	const space = cut.lastIndexOf(' ');
	return `${space > max - 80 ? cut.slice(0, space) : cut}…`;
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
