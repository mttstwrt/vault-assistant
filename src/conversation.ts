import { App, TFile, TFolder, moment, normalizePath } from 'obsidian';
import { VaultAssistantSettings } from './settings';
import { ChatMessage } from './types';

/** Build a stable file path for a new conversation from its first message. */
export function newConversationPath(settings: VaultAssistantSettings, firstMessage: string): string {
	const stamp = moment().format('YYYY-MM-DD HHmm');
	const slug = firstMessage
		.replace(/[\\/:*?"<>|#^[\]\n]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 40)
		.trim();
	const name = slug ? `${stamp} ${slug}` : stamp;
	return normalizePath(`${settings.conversationsFolder}/${name}.md`);
}

/** Render the transcript as readable markdown. */
function renderConversation(messages: ChatMessage[]): string {
	const lines: string[] = [
		'---',
		`created: ${moment().format('YYYY-MM-DD HH:mm')}`,
		'tags: [ai-conversation]',
		'---',
		'',
	];

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

	return lines.join('\n');
}

async function ensureFolder(app: App, folder: string): Promise<void> {
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
