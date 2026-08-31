import { App, TFile, moment, normalizePath } from 'obsidian';
import { VaultAssistantSettings } from '../settings';
import { ChatMessage } from '../types';
import { ensureFolder } from '../tools/files';
import { ImportOutcome, thinkingCallout, writeConversation } from './common';

/**
 * Import Claude Code session logs (the .jsonl files under ~/.claude/projects)
 * as readable transcripts in the conversations folder. Only the user's messages and the
 * assistant's thinking + answers are kept; tool calls, tool results, slash
 * commands, and harness metadata are dropped.
 *
 * Reads local files outside the vault, so this is desktop-only (same lazy
 * `require` pattern as the stdio MCP transport) and only runs when the user
 * explicitly triggers an import.
 */

/** One importable session found on disk. */
export interface ClaudeSession {
	/** Absolute path to the session's .jsonl file. */
	filePath: string;
	/** Project folder name (from the session's recorded cwd when available). */
	project: string;
	mtime: number;
	/** First real user message, for the picker list. */
	title: string;
}

function nodeFs(): typeof import('fs') {
	// Lazy require so this module still loads on platforms without Node.
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	return require('fs') as typeof import('fs');
}

/** The default Claude Code data directory for this machine. */
export function defaultProjectsDir(): string {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const os = require('os') as typeof import('os');
	return `${os.homedir()}/.claude/projects`;
}

/** One parsed line of a session .jsonl file (only the fields we use). */
interface RawEntry {
	type?: string;
	isMeta?: boolean;
	isSidechain?: boolean;
	cwd?: string;
	timestamp?: string;
	message?: { role?: string; content?: unknown };
}

interface ContentBlock {
	type?: string;
	text?: string;
	thinking?: string;
}

/**
 * Extract the keepable text of one log entry, or null for entries that are
 * harness noise (meta messages, slash commands, tool calls/results, sidechains).
 */
function entryMessage(entry: RawEntry): ChatMessage | null {
	if (entry.isMeta || entry.isSidechain) return null;
	const msg = entry.message;
	if (!msg) return null;

	if (entry.type === 'user' && msg.role === 'user') {
		let text: string;
		if (typeof msg.content === 'string') {
			text = msg.content;
		} else if (Array.isArray(msg.content)) {
			text = (msg.content as ContentBlock[])
				.filter((b) => b.type === 'text' && b.text)
				.map((b) => b.text)
				.join('\n\n');
		} else {
			return null;
		}
		// Drop slash-command records and interruption markers; strip injected
		// harness context from otherwise real messages.
		if (text.includes('<command-name>') || text.includes('<local-command-stdout')) return null;
		if (text.startsWith('[Request interrupted')) return null;
		text = text
			.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
			.replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '')
			.trim();
		return text ? { role: 'user', content: text } : null;
	}

	if (entry.type === 'assistant' && msg.role === 'assistant' && Array.isArray(msg.content)) {
		const parts: string[] = [];
		for (const block of msg.content as ContentBlock[]) {
			if (block.type === 'thinking' && block.thinking?.trim()) {
				parts.push(thinkingCallout(block.thinking));
			} else if (block.type === 'text' && block.text?.trim()) {
				parts.push(block.text.trim());
			}
			// tool_use blocks are intentionally dropped.
		}
		return parts.length ? { role: 'assistant', content: parts.join('\n\n') } : null;
	}

	return null;
}

export interface ParsedSession {
	messages: ChatMessage[];
	created?: string;
	cwd?: string;
}

/** Parse a full session .jsonl into clean user/assistant messages. */
export function parseSession(jsonl: string): ParsedSession {
	const messages: ChatMessage[] = [];
	let created: string | undefined;
	let cwd: string | undefined;

	for (const line of jsonl.split('\n')) {
		if (!line.trim()) continue;
		let entry: RawEntry;
		try {
			entry = JSON.parse(line) as RawEntry;
		} catch {
			continue;
		}
		created ??= entry.timestamp;
		cwd ??= entry.cwd;

		const m = entryMessage(entry);
		if (!m) continue;
		// One assistant turn spans several log entries (one per model step);
		// merge them so the transcript reads as a single reply.
		const prev = messages[messages.length - 1];
		if (prev && prev.role === 'assistant' && m.role === 'assistant') {
			prev.content += `\n\n${m.content}`;
		} else {
			messages.push(m);
		}
	}

	return { messages, created, cwd };
}

/** Scan a Claude Code projects directory for importable sessions, newest first. */
export function listSessions(projectsDir: string): ClaudeSession[] {
	const fs = nodeFs();
	const sessions: ClaudeSession[] = [];

	for (const proj of fs.readdirSync(projectsDir, { withFileTypes: true })) {
		if (!proj.isDirectory()) continue;
		const projDir = `${projectsDir}/${proj.name}`;
		for (const name of fs.readdirSync(projDir)) {
			if (!name.endsWith('.jsonl')) continue;
			const filePath = `${projDir}/${name}`;
			// Sessions are usually titled within the first few entries; reading
			// a bounded head keeps scanning large histories fast.
			const head = parseSession(readHead(fs, filePath, 256 * 1024));
			const firstUser = head.messages.find((m) => m.role === 'user');
			if (!firstUser) continue; // command-only or empty session
			sessions.push({
				filePath,
				project: head.cwd?.split('/').pop() ?? proj.name,
				mtime: fs.statSync(filePath).mtimeMs,
				title: (firstUser.content.split('\n')[0] ?? '').slice(0, 120),
			});
		}
	}

	return sessions.sort((a, b) => b.mtime - a.mtime);
}

/** Read at most `bytes` from the start of a file, dropping any partial last line. */
function readHead(fs: typeof import('fs'), filePath: string, bytes: number): string {
	const fd = fs.openSync(filePath, 'r');
	try {
		const buf = Buffer.alloc(bytes);
		const read = fs.readSync(fd, buf, 0, bytes, 0);
		const text = buf.toString('utf8', 0, read);
		return read < bytes ? text : text.slice(0, text.lastIndexOf('\n') + 1);
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * Import one session as a markdown transcript under
 * `<conversations>/Claude Code/<project>/`. Skips sessions already imported
 * (same deterministic path) and sessions with no real messages.
 */
export async function importSession(
	app: App,
	settings: VaultAssistantSettings,
	session: ClaudeSession,
): Promise<ImportOutcome> {
	const parsed = parseSession(nodeFs().readFileSync(session.filePath, 'utf8'));
	const firstUser = parsed.messages.find((m) => m.role === 'user');
	if (!firstUser) return 'empty';

	return writeConversation(app, settings, {
		source: 'claude-code',
		folder: `Claude Code/${session.project}`,
		title: firstUser.content,
		created: parsed.created ?? session.mtime,
		frontmatter: parsed.cwd ? [`project: "${parsed.cwd}"`] : [],
		messages: parsed.messages,
	});
}

/** One line of ~/.claude/history.jsonl: a prompt the user typed, with context. */
export interface HistoryEntry {
	display?: string;
	project?: string;
	sessionId?: string;
	timestamp?: number;
}

export interface PromptHistory {
	/** Prompts whose full session transcript no longer exists on disk. */
	orphaned: HistoryEntry[];
	total: number;
}

/**
 * Read the prompt history (a sibling of the projects directory) and find the
 * prompts that outlived their session files — Claude Code's cleanup deletes
 * transcripts after ~30 days, but history.jsonl keeps the user's own prompts
 * far longer. Those orphans are all that remains of expired conversations.
 */
export function scanPromptHistory(projectsDir: string): PromptHistory {
	const fs = nodeFs();
	const dir = projectsDir.replace(/\/+$/, '');
	const historyPath = `${dir.split('/').slice(0, -1).join('/')}/history.jsonl`;
	if (!fs.existsSync(historyPath)) return { orphaned: [], total: 0 };

	const onDisk = new Set<string>();
	for (const proj of fs.readdirSync(dir, { withFileTypes: true })) {
		if (!proj.isDirectory()) continue;
		for (const name of fs.readdirSync(`${dir}/${proj.name}`)) {
			if (name.endsWith('.jsonl')) onDisk.add(name.slice(0, -'.jsonl'.length));
		}
	}

	const orphaned: HistoryEntry[] = [];
	let total = 0;
	for (const line of fs.readFileSync(historyPath, 'utf8').split('\n')) {
		if (!line.trim()) continue;
		let e: HistoryEntry;
		try {
			e = JSON.parse(line) as HistoryEntry;
		} catch {
			continue;
		}
		if (!e.display?.trim()) continue;
		total++;
		if (!e.sessionId || !onDisk.has(e.sessionId)) orphaned.push(e);
	}
	return { orphaned, total };
}

/** Render the orphaned prompts as one note, grouped by project, oldest first. */
export function renderPromptHistory(orphaned: HistoryEntry[]): string {
	const byProject = new Map<string, HistoryEntry[]>();
	for (const e of orphaned) {
		const key = e.project ?? '(unknown project)';
		let group = byProject.get(key);
		if (!group) byProject.set(key, (group = []));
		group.push(e);
	}

	const lines = [
		'---',
		`updated: ${moment().format('YYYY-MM-DD HH:mm')}`,
		'source: claude-code',
		'tags: [ai-conversation, claude-code, prompt-history]',
		'---',
		'',
		"Prompts rescued from Claude Code's prompt history (`history.jsonl`) whose full",
		'session transcripts have already been cleaned up. Only your side of those',
		'conversations survives. Regenerated in full on each import.',
		'',
	];
	for (const [project, entries] of [...byProject.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
		lines.push(`## ${project}`, '');
		entries.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
		for (const e of entries) {
			const stamp = e.timestamp ? moment(e.timestamp).format('YYYY-MM-DD HH:mm') : '(no date)';
			const quoted = (e.display ?? '')
				.trim()
				.split('\n')
				.map((l) => `> ${l}`)
				.join('\n');
			lines.push(`> **${stamp}**`, quoted, '');
		}
	}
	return lines.join('\n');
}

/**
 * Write (or refresh) the rescued-prompts note. Overwrites the previous
 * version: history.jsonl only grows, so a regeneration never loses entries.
 */
export async function writePromptHistory(
	app: App,
	settings: VaultAssistantSettings,
	orphaned: HistoryEntry[],
): Promise<ImportOutcome> {
	if (!orphaned.length) return 'empty';
	const dir = normalizePath(`${settings.conversationsFolder}/Claude Code`);
	const path = normalizePath(`${dir}/Prompt history.md`);
	const md = renderPromptHistory(orphaned);
	await ensureFolder(app, dir);
	const existing = app.vault.getAbstractFileByPath(path);
	if (existing instanceof TFile) await app.vault.modify(existing, md);
	else await app.vault.create(path, md);
	return 'imported';
}
