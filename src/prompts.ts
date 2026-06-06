import { App } from 'obsidian';
import { VaultAssistantSettings } from './settings';
import { displayScopes, readScopes, writeScopes } from './permissions';
import { buildMemorySection } from './memory';

/**
 * Build the full system prompt: the user's base instructions, a live
 * description of the current folders and permissions so the model knows exactly
 * what it may touch, and the agent's operating memory for this vault.
 */
export async function buildSystemPrompt(app: App, settings: VaultAssistantSettings): Promise<string> {
	const readDesc =
		settings.readScope === 'vault'
			? 'the entire vault'
			: `only these folders: ${displayScopes(readScopes(settings))}`;

	const env = [
		'',
		'--- Environment ---',
		`Conversations folder: ${settings.conversationsFolder}`,
		`Wiki folder: ${settings.wikiFolder}`,
		`You can READ: ${readDesc}.`,
		`You can WRITE only inside: ${displayScopes(writeScopes(settings))}.`,
		'Attempts to write elsewhere will be rejected, so do not try.',
	].join('\n');

	const memory = await buildMemorySection(app, settings);

	return `${settings.systemPrompt}\n${env}${memory}`;
}
