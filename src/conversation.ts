import { App, TFile, TFolder, moment, normalizePath } from 'obsidian';
import { VaultAssistantSettings } from './settings';
import { ChatMessage } from './types';

/** Sanitise a title or first message into a short filename-safe slug. */
export function conversationSlug(label: string): string {
	return label
		.replace(/[\\/:*?"<>|#^[\]\n]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 40)
		.trim();
}

/**
 * Build a file path for a new conversation: the date and time, then `label` —
 * the model's suggested title, or the first message when there isn't one. A
 * name already taken (same minute, same topic) gets a counter instead of
 * overwriting the existing transcript.
 */
export function newConversationPath(
	app: App,
	settings: VaultAssistantSettings,
	label: string,
): string {
	const stamp = moment().format('YYYY-MM-DD HHmm');
	const slug = conversationSlug(label);
	const base = slug ? `${stamp} ${slug}` : stamp;
	const pathFor = (name: string): string =>
		normalizePath(`${settings.conversationsFolder}/${name}.md`);

	let path = pathFor(base);
	for (let n = 2; app.vault.getAbstractFileByPath(path) && n < 100; n++) {
		path = pathFor(`${base} (${n})`);
	}
	return path;
}

/** Render messages (no frontmatter) as readable markdown lines. */
export function renderMessages(messages: ChatMessage[]): string[] {
	const lines: string[] = [];
	for (const m of messages) {
		if (m.role === 'user') {
			lines.push('## 🧑 You', '', m.content, '');
		} else if (m.role === 'assistant') {
			if (m.content) lines.push('## 🤖 Assistant', '', m.content, '');
			for (const call of m.toolCalls ?? []) {
				lines.push(`> 🔧 \`${call.name}(${call.arguments})\``, '');
			}
		}
		// `tool` result messages are intentionally omitted to keep transcripts clean.
	}
	return lines;
}

/** Render the transcript as readable markdown. */
function renderConversation(messages: ChatMessage[]): string {
	const lines: string[] = [
		'---',
		`created: ${moment().format('YYYY-MM-DD HH:mm')}`,
		'tags: [ai-conversation]',
		'---',
		'',
		...renderMessages(messages),
	];
	return lines.join('\n');
}

/**
 * Parse a saved transcript back into user/assistant messages so a previous
 * conversation can be reopened. Tool-call records (`> 🔧 …`) are dropped —
 * they aren't replayable without their results.
 */
export function parseConversation(md: string): ChatMessage[] {
	let body = md;
	if (body.startsWith('---\n')) {
		const end = body.indexOf('\n---\n', 4);
		if (end !== -1) body = body.slice(end + 5);
	}

	const messages: ChatMessage[] = [];
	let role: 'user' | 'assistant' | null = null;
	let buf: string[] = [];
	const flush = (): void => {
		if (!role) return;
		const content = buf.join('\n').trim();
		if (content) messages.push({ role, content });
		buf = [];
	};

	for (const line of body.split('\n')) {
		if (line.startsWith('## 🧑 You')) {
			flush();
			role = 'user';
		} else if (line.startsWith('## 🤖 Assistant')) {
			flush();
			role = 'assistant';
		} else if (!line.startsWith('> 🔧 `')) {
			buf.push(line);
		}
	}
	flush();
	return messages;
}

export async function ensureFolder(app: App, folder: string): Promise<void> {
	const parts = normalizePath(folder).split('/').filter(Boolean);
	let cur = '';
	for (const p of parts) {
		cur = cur ? `${cur}/${p}` : p;
		if (!app.vault.getAbstractFileByPath(cur)) {
			try {
				await app.vault.createFolder(cur);
			} catch {
				// ignore races / already-exists
			}
		}
	}
}

/** Write (or overwrite) the conversation transcript at `path`. */
export async function saveConversation(
	app: App,
	settings: VaultAssistantSettings,
	path: string,
	messages: ChatMessage[],
): Promise<void> {
	const dir = path.split('/').slice(0, -1).join('/');
	if (dir) await ensureFolder(app, dir);

	const md = renderConversation(messages);
	const existing = app.vault.getAbstractFileByPath(path);
	if (existing instanceof TFile) {
		await app.vault.modify(existing, md);
	} else if (!(existing instanceof TFolder)) {
		await app.vault.create(path, md);
	}
}

/**
 * Append newly-added messages to an existing transcript. Used when continuing
 * a reopened conversation, so the original file (including its old tool-call
 * records) is preserved instead of being re-rendered from parsed history.
 */
export async function appendConversation(
	app: App,
	path: string,
	messages: ChatMessage[],
): Promise<void> {
	const file = app.vault.getAbstractFileByPath(path);
	if (!(file instanceof TFile)) throw new Error(`Conversation file not found: ${path}`);
	const md = renderMessages(messages).join('\n');
	if (md.trim()) await app.vault.append(file, `\n${md}`);
}
