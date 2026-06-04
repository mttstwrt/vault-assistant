import { AIChatSettings } from './settings';
import { displayScopes, readScopes, writeScopes } from './permissions';

/**
 * Build the full system prompt: the user's base instructions plus a live
 * description of the current folders and permissions so the model knows
 * exactly what it may touch.
 */
export function buildSystemPrompt(settings: AIChatSettings): string {
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

	return `${settings.systemPrompt}\n${env}`;
}
