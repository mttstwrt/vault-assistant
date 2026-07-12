import { App } from 'obsidian';
import { VaultAssistantSettings } from './settings';
import { buildWikiHomePointer } from './tools/graph';

/**
 * The compact "Wiki index" block injected into the system prompt, or '' when
 * disabled or the wiki is empty. The two-layer principle: this is only the
 * shape of the curated knowledge (the Home page's table of contents) — the
 * agent explores the wiki itself lazily by following [[links]].
 */
export async function buildWikiSection(
	app: App,
	settings: VaultAssistantSettings,
): Promise<string> {
	if (!settings.useWikiIndex) return '';
	const pointer = await buildWikiHomePointer(app, settings);
	if (!pointer) return '';
	return [
		'',
		'--- Wiki index (curated knowledge — enter here, then follow [[links]] with wiki_page) ---',
		pointer,
	].join('\n');
}
