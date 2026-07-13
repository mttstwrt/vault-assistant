import { ChatMessage } from '../types';
import { ImportedConversation, thinkingCallout } from './common';

/**
 * Parse the conversations.json from a claude.ai data export
 * (claude.ai → Settings → Privacy → Export data, then unzip the attachment).
 */

interface ClaudeWebBlock {
	type?: string;
	text?: string;
	thinking?: string;
}

interface ClaudeWebMessage {
	sender?: string;
	text?: string;
	content?: ClaudeWebBlock[];
}

interface ClaudeWebChat {
	name?: string;
	created_at?: string;
	chat_messages?: ClaudeWebMessage[];
}

export function parseClaudeWebExport(json: string): ImportedConversation[] {
	let data: unknown;
	try {
		data = JSON.parse(json) as unknown;
	} catch {
		throw new Error('Not valid JSON.');
	}
	if (!Array.isArray(data)) {
		throw new Error('Expected a JSON array — choose the conversations.json from a claude.ai export.');
	}

	const out: ImportedConversation[] = [];
	for (const chat of data as ClaudeWebChat[]) {
		if (!Array.isArray(chat?.chat_messages)) continue;

		const messages: ChatMessage[] = [];
		for (const m of chat.chat_messages) {
			const role = m.sender === 'human' ? 'user' : m.sender === 'assistant' ? 'assistant' : null;
			if (!role) continue;

			// Prefer content blocks (they separate thinking from the answer);
			// fall back to the flat text field on older exports.
			const parts: string[] = [];
			for (const b of m.content ?? []) {
				if (b.type === 'thinking' && b.thinking?.trim()) parts.push(thinkingCallout(b.thinking));
				else if (b.type === 'text' && b.text?.trim()) parts.push(b.text.trim());
			}
			if (!parts.length && m.text?.trim()) parts.push(m.text.trim());
			if (parts.length) messages.push({ role, content: parts.join('\n\n') });
		}
		if (!messages.length) continue;

		out.push({
			source: 'claude-web',
			folder: 'Claude',
			title: chat.name?.trim() || messages.find((m) => m.role === 'user')?.content || '',
			created: chat.created_at,
			messages,
		});
	}

	if (!out.length && (data as unknown[]).length) {
		throw new Error('No conversations recognised — is this the conversations.json from a claude.ai export?');
	}
	return out;
}
