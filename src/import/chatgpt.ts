import { ChatMessage } from '../types';
import { ImportedConversation, thinkingCallout } from './common';

/**
 * Parse the conversations.json from a ChatGPT data export
 * (chatgpt.com → Settings → Data controls → Export data, then unzip the
 * attachment). Each conversation is a tree of message branches; only the
 * active branch (current_node back to the root) is imported.
 */

interface GptContent {
	content_type?: string;
	parts?: unknown[];
	thoughts?: { summary?: string; content?: string }[];
}

interface GptMessage {
	author?: { role?: string };
	content?: GptContent;
	recipient?: string;
	metadata?: { is_visually_hidden_from_conversation?: boolean };
}

interface GptNode {
	message?: GptMessage | null;
	parent?: string | null;
}

interface GptConvo {
	title?: string;
	create_time?: number;
	mapping?: Record<string, GptNode>;
	current_node?: string;
}

/** The keepable text of one message, or null for tool payloads and the like. */
function messageText(m: GptMessage): string | null {
	const c = m.content;
	if (!c) return null;
	if (c.content_type === 'text' || c.content_type === 'multimodal_text') {
		const text = (c.parts ?? [])
			.filter((p): p is string => typeof p === 'string')
			.join('\n')
			.trim();
		return text || null;
	}
	if (c.content_type === 'thoughts' && Array.isArray(c.thoughts)) {
		const t = c.thoughts
			.map((th) => th.content ?? th.summary ?? '')
			.filter(Boolean)
			.join('\n\n')
			.trim();
		return t ? thinkingCallout(t) : null;
	}
	return null; // code, tool results, images, …
}

/** Walk the active branch from current_node up to the root, oldest first. */
function linearize(convo: GptConvo): GptMessage[] {
	const mapping = convo.mapping ?? {};
	let id: string | undefined = convo.current_node;
	if (!id || !mapping[id]) {
		// Older exports may omit current_node; fall back to any leaf.
		const parents = new Set(Object.values(mapping).map((n) => n.parent).filter(Boolean));
		id = Object.keys(mapping).find((k) => !parents.has(k));
	}

	const out: GptMessage[] = [];
	while (id) {
		const node: GptNode | undefined = mapping[id];
		if (!node) break;
		if (node.message) out.push(node.message);
		id = node.parent ?? undefined;
	}
	return out.reverse();
}

export function parseChatGptExport(json: string): ImportedConversation[] {
	let data: unknown;
	try {
		data = JSON.parse(json) as unknown;
	} catch {
		throw new Error('Not valid JSON.');
	}
	if (!Array.isArray(data)) {
		throw new Error('Expected a JSON array — choose the conversations.json from a ChatGPT export.');
	}

	const out: ImportedConversation[] = [];
	for (const convo of data as GptConvo[]) {
		if (!convo?.mapping) continue;

		const messages: ChatMessage[] = [];
		for (const m of linearize(convo)) {
			const role = m.author?.role;
			if (role !== 'user' && role !== 'assistant') continue;
			if (m.recipient && m.recipient !== 'all') continue; // tool invocation
			if (m.metadata?.is_visually_hidden_from_conversation) continue;
			const text = messageText(m);
			if (!text) continue;
			// Merge steps of one reply (thoughts + answer) into a single turn.
			const prev = messages[messages.length - 1];
			if (prev && prev.role === role) prev.content += `\n\n${text}`;
			else messages.push({ role, content: text });
		}
		if (!messages.some((m) => m.role === 'user')) continue;

		out.push({
			source: 'chatgpt',
			folder: 'ChatGPT',
			title: convo.title?.trim() || messages.find((m) => m.role === 'user')?.content || '',
			created: convo.create_time ? convo.create_time * 1000 : undefined,
			messages,
		});
	}

	if (!out.length && (data as unknown[]).length) {
		throw new Error('No conversations recognised — is this the conversations.json from a ChatGPT export?');
	}
	return out;
}
