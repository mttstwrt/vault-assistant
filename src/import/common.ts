import { App, moment, normalizePath } from 'obsidian';
import { VaultAssistantSettings } from '../settings';
import { ChatMessage } from '../types';
import { conversationSlug, ensureFolder, renderMessages } from '../conversation';

/**
 * Shared shape for the universal importer: every source (Claude Code logs,
 * claude.ai exports, ChatGPT exports, …) parses its data into this, and
 * writeConversation turns it into a transcript note.
 */
export interface ImportedConversation {
	/** Frontmatter source id, also used as a tag, e.g. "claude-web". */
	source: string;
	/** Subfolder under the conversations folder, e.g. "Claude Code/LightView". */
	folder: string;
	/** Names the file (slugged); usually the export's title or the first message. */
	title: string;
	/** moment()-parseable creation time (ISO string or epoch ms). */
	created?: string | number;
	/** Extra frontmatter lines, e.g. `project: "/path"`. */
	frontmatter?: string[];
	messages: ChatMessage[];
}

export type ImportOutcome = 'imported' | 'skipped' | 'empty';

/** Render extended thinking as a collapsed callout so transcripts stay tidy. */
export function thinkingCallout(thinking: string): string {
	const quoted = thinking
		.trim()
		.split('\n')
		.map((l) => `> ${l}`)
		.join('\n');
	return `> [!quote]- Thinking\n${quoted}`;
}

/**
 * Write one imported conversation as a markdown transcript. Skips
 * conversations already imported (same deterministic path) and empty ones.
 */
export async function writeConversation(
	app: App,
	settings: VaultAssistantSettings,
	c: ImportedConversation,
): Promise<ImportOutcome> {
	if (!c.messages.length) return 'empty';

	const when = c.created !== undefined ? moment(c.created) : moment();
	const slug = conversationSlug(c.title);
	const dir = normalizePath(`${settings.conversationsFolder}/${c.folder}`);
	const path = normalizePath(`${dir}/${when.format('YYYY-MM-DD HHmm')}${slug ? ` ${slug}` : ''}.md`);
	if (app.vault.getAbstractFileByPath(path)) return 'skipped';

	const lines = [
		'---',
		`created: ${when.format('YYYY-MM-DD HH:mm')}`,
		`source: ${c.source}`,
		...(c.frontmatter ?? []),
		`tags: [ai-conversation, ${c.source}]`,
		'---',
		'',
		...renderMessages(c.messages),
	];
	await ensureFolder(app, dir);
	await app.vault.create(path, lines.join('\n'));
	return 'imported';
}
