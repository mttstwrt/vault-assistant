import { App, TFile, normalizePath } from 'obsidian';
import { VaultAssistantSettings } from './settings';

/**
 * The agent's "operating memory": a small, curated note describing how THIS
 * vault works — where data lives, the formats and conventions the user uses,
 * and corrections they have given. Unlike the wiki (which holds *content*
 * knowledge and is explored on demand), this file is injected into the system
 * prompt at the start of every conversation, so durable facts are recalled with
 * zero tool calls. Keep it short and high-signal.
 */
export async function readMemory(app: App, settings: VaultAssistantSettings): Promise<string> {
	if (!settings.useMemory || !settings.memoryFile.trim()) return '';
	const p = normalizePath(settings.memoryFile);
	const f = app.vault.getAbstractFileByPath(p);
	if (!(f instanceof TFile)) return '';
	return (await app.vault.cachedRead(f)).trim();
}

/** The "Operating memory" block injected into the system prompt, or '' if off. */
export async function buildMemorySection(app: App, settings: VaultAssistantSettings): Promise<string> {
	if (!settings.useMemory) return '';
	const memory = await readMemory(app, settings);
	return [
		'',
		'--- Operating memory (what you already know about this vault) ---',
		memory ||
			'(empty — nothing learned yet. As you discover how this vault is organised, record durable facts with the remember tool.)',
	].join('\n');
}
