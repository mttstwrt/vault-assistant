import { App, TFile, normalizePath } from 'obsidian';
import { VaultAssistantSettings } from '../settings';
import { isReadable } from '../permissions';

/** True when `path` sits inside (or equals) `folder`. */
export function inFolder(path: string, folder: string): boolean {
	const f = normalizePath(folder).replace(/^\/+|\/+$/g, '');
	const p = normalizePath(path);
	if (!f) return true;
	return p === f || p.startsWith(f + '/');
}

/** Invert the metadata cache into a target → sources backlink map. */
export function buildBacklinks(app: App): Record<string, string[]> {
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

/** Vault path of the wiki's Home (entry) page. */
export function wikiHomePath(settings: VaultAssistantSettings): string {
	const title = settings.wikiHomeNote.trim() || 'Home';
	return normalizePath(`${settings.wikiFolder}/${title}.md`);
}

/**
 * A readable map of the wiki: every wiki note plus its outgoing links and the
 * notes (anywhere in the vault, including past conversations) that link to it,
 * followed by a maintenance worklist (orphan pages, broken links). Lets the
 * agent extend, cross-link, and curate the wiki coherently across sessions.
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

	// Maintenance worklist: what curation should fix next.
	const home = wikiHomePath(settings);
	const orphans = files.filter((f) => f.path !== home && !(back[f.path] ?? []).length);
	const broken: string[] = [];
	for (const f of files) {
		const unresolved = Object.keys(app.metadataCache.unresolvedLinks[f.path] ?? {});
		if (unresolved.length) broken.push(`${f.path} → ${unresolved.join(', ')}`);
	}
	if (orphans.length || broken.length) {
		lines.push('', 'Maintenance needed:');
		if (orphans.length) {
			lines.push(`- Orphan pages (no backlinks — link them into ${home} or a related page):`);
			for (const f of orphans) lines.push(`    ${f.path}`);
		}
		if (broken.length) {
			lines.push('- Broken [[links]] (create the target page or fix the link):');
			for (const b of broken) lines.push(`    ${b}`);
		}
	}
	return lines.join('\n');
}

/**
 * A compact pointer to the wiki's curated entry point, for session-start
 * injection: the Home page's first lines (its table of contents), not the
 * whole wiki. Returns '' when the wiki is empty — nothing to point at.
 */
export async function buildWikiHomePointer(
	app: App,
	settings: VaultAssistantSettings,
): Promise<string> {
	const pages = app.vault.getMarkdownFiles().filter((f) => inFolder(f.path, settings.wikiFolder));
	if (!pages.length) return '';

	const homePath = wikiHomePath(settings);
	const home = app.vault.getAbstractFileByPath(homePath);
	if (!(home instanceof TFile)) {
		return `The wiki has ${pages.length} page(s) but no "${homePath}" entry page yet. When you next work with the wiki, create it with update_wiki: a short, curated table of contents whose [[links]] lead to the top-level topics.`;
	}

	const MAX_LINES = 40;
	const MAX_CHARS = 1500;
	const text = (await app.vault.cachedRead(home)).trim();
	const lines = text.split('\n');
	const head = lines.slice(0, MAX_LINES).join('\n').slice(0, MAX_CHARS).trimEnd();
	const truncated = head.length < text.length ? '\n…(truncated — wiki_home shows the full page)' : '';
	return `Entry page ${homePath} (${pages.length} wiki pages in total):\n${head}${truncated}`;
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
