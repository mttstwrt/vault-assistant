import { App } from 'obsidian';
import { VaultAssistantSettings } from './settings';
import { displayScopes, writeScopes } from './permissions';
import { buildMemorySection } from './memory';

/**
 * Build the full system prompt: the user's base instructions, a live
 * description of the current folders and permissions so the model knows exactly
 * what it may touch, and the agent's operating memory for this vault.
 */
export async function buildSystemPrompt(app: App, settings: VaultAssistantSettings): Promise<string> {
	const readDesc = settings.readBlockPaths.length
		? 'your whole vault except a few private areas the user has blocked (those files are hidden from you)'
		: 'your whole vault';

	const env = [
		'',
		'--- Environment ---',
		`Conversations folder: ${settings.conversationsFolder}`,
		`Wiki folder: ${settings.wikiFolder}`,
		`You can READ: ${readDesc}.`,
		`You can WRITE freely inside: ${displayScopes(writeScopes(settings))}.`,
		'Writing anywhere else will pause and ask the user to approve it first, so only write outside these folders when the user has actually asked you to.',
	].join('\n');

	const memory = await buildMemorySection(app, settings);

	return `${settings.systemPrompt}\n${env}${memory}`;
}
