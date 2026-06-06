import { App, TFile, normalizePath } from 'obsidian';
import { VaultAssistantSettings } from '../settings';
import { isReadable } from '../permissions';

/** True when `path` sits inside (or equals) `folder`. */
function inFolder(path: string, folder: string): boolean {
	const f = normalizePath(folder).replace(/^\/+|\/+$/g, '');
	const p = normalizePath(path);
	if (!f) return true;
	return p === f || p.startsWith(f + '/');
}

/** Invert the metadata cache into a target → sources backlink map. */
function buildBacklinks(app: App): Record<string, string[]> {
	const resolved = app.metadataCache.resolvedLinks;
	const back: Record<string, string[]> = {};
	for (const src of Object.keys(resolved)) {
		const targets = resolved[src];
		if (!targets) continue;
		for (const tgt of Object.keys(targets)) {
			(back[tgt] ??= []).push(src);
		}
	}
	return back;
}

/**
 * A readable map of the wiki: every wiki note plus its outgoing links and the
 * notes (anywhere in the vault, including past conversations) that link to it.
 * Lets the agent extend and cross-link the wiki coherently across sessions.
 */
export function buildWikiIndex(app: App, settings: VaultAssistantSettings): string {
	const files = app.vault
		.getMarkdownFiles()
		.filter((f) => inFolder(f.path, settings.wikiFolder))
		.sort((a, b) => a.path.localeCompare(b.path));

	if (!files.length) {
		return `The wiki folder "${settings.wikiFolder}" has no notes yet. Create the first one with update_wiki.`;
	}

	const resolved = app.metadataCache.resolvedLinks;
	const back = buildBacklinks(app);
	const lines: string[] = [`Wiki notes in "${settings.wikiFolder}":`];
	for (const f of files) {
		const out = Object.keys(resolved[f.path] ?? {});
		const incoming = back[f.path] ?? [];
		lines.push(`- ${f.path}`);
		if (out.length) lines.push(`    → links to: ${out.join(', ')}`);
		if (incoming.length) lines.push(`    ← linked from: ${incoming.join(', ')}`);
	}
	return lines.join('\n');
}

/** Outgoing links, backlinks, and broken links for a single note. */
export function describeLinks(app: App, settings: VaultAssistantSettings, path: string): string {
	const p = normalizePath(path);
	const f = app.vault.getAbstractFileByPath(p);
	if (!(f instanceof TFile)) return `Error: file not found: "${p}".`;
	if (!isReadable(p, settings)) return `Error: reading "${p}" is not permitted.`;

	const out = Object.keys(app.metadataCache.resolvedLinks[p] ?? {});
	const incoming = buildBacklinks(app)[p] ?? [];
	const unresolved = Object.keys(app.metadataCache.unresolvedLinks[p] ?? {});

	const parts: string[] = [`Links for ${p}:`];
	parts.push(out.length ? `Links to: ${out.join(', ')}` : 'Links to: (none)');
	parts.push(incoming.length ? `Linked from: ${incoming.join(', ')}` : 'Linked from: (none)');
	if (unresolved.length) parts.push(`Unresolved [[links]]: ${unresolved.join(', ')}`);
	return parts.join('\n');
}
