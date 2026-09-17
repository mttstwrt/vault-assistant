import { App, TFile, TFolder, moment, normalizePath } from 'obsidian';
import { VaultAssistantSettings } from './settings';
import { ChatMessage, TranscriptEntry } from './types';
import { parseTranscript, renderTranscript, toMessages } from './transcript';
import { ensureFolder } from './tools/files';

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
 * A model-suggested folder name, made safe to sit under the conversations
 * folder. conversationSlug already drops the path separators and the characters
 * Obsidian rejects in a name; removing dots on top of that leaves nothing that
 * can climb out of the folder or nest inside it, so "one level deep" holds
 * structurally rather than as a rule someone has to remember to enforce.
 */
function folderSlug(label: string): string {
	return conversationSlug(label).replace(/\./g, '').replace(/\s+/g, ' ').trim();
}

/**
 * The folders already in use under the conversations folder. Shown to the model
 * when it files a new conversation, so it reuses one instead of inventing this
 * week's synonym for a folder that already exists.
 */
export function conversationFolders(app: App, settings: VaultAssistantSettings): string[] {
	const root = app.vault.getAbstractFileByPath(normalizePath(settings.conversationsFolder));
	if (!(root instanceof TFolder)) return [];
	return root.children
		.filter((c): c is TFolder => c instanceof TFolder)
		.map((f) => f.name)
		.sort((a, b) => a.localeCompare(b));
}

/**
 * Build a file path for a new conversation: the date and time, then `label` —
 * the model's suggested title, or the first message when there isn't one —
 * inside `folder` when the model filed it somewhere. Both come from the model,
 * so both are slugged here; that makes this the one place a suggested name can
 * become part of a path. A name already taken (same minute, same topic) gets a
 * counter instead of overwriting the existing transcript.
 */
export function newConversationPath(
	app: App,
	settings: VaultAssistantSettings,
	label: string,
	folder = '',
): string {
	const stamp = moment().format('YYYY-MM-DD HHmm');
	const slug = conversationSlug(label);
	const base = slug ? `${stamp} ${slug}` : stamp;
	const dir = folderSlug(folder);
	const parent = dir ? `${settings.conversationsFolder}/${dir}` : settings.conversationsFolder;
	const pathFor = (name: string): string => normalizePath(`${parent}/${name}.md`);

	let path = pathFor(base);
	for (let n = 2; app.vault.getAbstractFileByPath(path) && n < 100; n++) {
		path = pathFor(`${base} (${n})`);
	}
	return path;
}

/**
 * Render the transcript as a readable note.
 *
 * `branchedFrom` is the transcript this one was forked from, written as a
 * [[link]] rather than a path: that gives the parent a backlink, so the fork
 * shows up in Obsidian's graph and in the `links` tool without either note
 * having to be told about the other twice.
 */
function renderConversation(entries: TranscriptEntry[], branchedFrom: string | null): string {
	return [
		'---',
		`created: ${moment().format('YYYY-MM-DD HH:mm')}`,
		...(branchedFrom ? [`branched-from: "[[${branchedFrom}]]"`] : []),
		'tags: [ai-conversation]',
		'---',
		'',
		...renderTranscript(entries),
	].join('\n');
}

/** Read a saved transcript back into the record the panel shows. */
export function openTranscript(md: string): TranscriptEntry[] {
	return parseTranscript(md);
}

/**
 * A saved transcript as messages, for readers that only want what was said —
 * the semantic indexer, and anything else that treats a conversation as text
 * rather than as a session to resume.
 */
export function parseConversation(md: string): ChatMessage[] {
	return toMessages(parseTranscript(md));
}

/** Write (or overwrite) the conversation transcript at `path`. */
export async function saveConversation(
	app: App,
	settings: VaultAssistantSettings,
	path: string,
	entries: TranscriptEntry[],
	branchedFrom: string | null = null,
): Promise<void> {
	const dir = path.split('/').slice(0, -1).join('/');
	if (dir) await ensureFolder(app, dir);

	const md = renderConversation(entries, branchedFrom);
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
	entries: TranscriptEntry[],
): Promise<void> {
	const file = app.vault.getAbstractFileByPath(path);
	if (!(file instanceof TFile)) throw new Error(`Conversation file not found: ${path}`);
	const md = renderTranscript(entries).join('\n');
	if (md.trim()) await app.vault.append(file, `\n${md}`);
}
