import { App } from 'obsidian';
import { VaultAssistantSettings } from './settings';
import { displayScopes, writeScopes } from './permissions';
import { buildMemorySection } from './memory';
import { buildWikiSection } from './wiki';
import { activeToolSpecs } from './tools/vault-tools';

/**
 * Build the full system prompt: the user's base instructions, a live
 * description of the current folders and permissions so the model knows exactly
 * what it may touch, and the agent's operating memory for this vault.
 */
export async function buildSystemPrompt(app: App, settings: VaultAssistantSettings): Promise<string> {
	const readDesc = settings.readBlockPaths.length
		? 'your whole vault except a few private areas the user has blocked (those files are hidden from you)'
		: 'your whole vault';

	// Stated as environment rather than advice, because it is not negotiable:
	// models trained as coding agents otherwise spend rounds trying `ls` and
	// `cat` before they reach for the vault tools.
	const access = [
		'',
		'--- How you reach this vault ---',
		'You have no shell, no filesystem access and no network access. The tools listed for this request are your only way to see or change anything, and they act on the vault through Obsidian, not on files on disk.',
		`Vault tools: ${activeToolSpecs(settings)
			.map((t) => t.name)
			.join(', ')}${settings.mcpServers.some((s) => s.enabled) ? ', plus any MCP tools listed for this request' : ''}.`,
		'Paths are always relative to the vault root — "Notes/Ideas.md", never "/home/you/Vault/Notes/Ideas.md" or "C:\\...". There is no working directory, no "~", and no leading slash.',
		'Before telling the user what you can or cannot do — or how Obsidian will react to something you are about to do, such as whether links follow a note you move — call capabilities. It answers from this vault\'s live settings. Do not guess.',
	].join('\n');

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
	const wiki = await buildWikiSection(app, settings);

	return `${settings.systemPrompt}\n${access}\n${env}${memory}${wiki}`;
}
