/**
 * Tags, read from the metadata cache rather than from note contents.
 *
 * getAllTags is the reason this defers rather than parsing: it merges inline
 * #tags with the frontmatter `tags` field, including the several shapes that
 * field takes (a list, a string, a comma-separated string), which is exactly
 * the parsing nobody should write a second time. No file is read here at all,
 * which makes this the cheapest tool in the set on a large vault.
 */
import { App, getAllTags } from 'obsidian';
import { VaultAssistantSettings } from '../settings';
import { isReadable } from '../permissions';

/** Every readable note's tags, as a tag → paths map. */
function collect(app: App, settings: VaultAssistantSettings): Map<string, string[]> {
	const byTag = new Map<string, string[]>();
	for (const file of app.vault.getMarkdownFiles()) {
		if (!isReadable(file.path, settings)) continue;
		const cache = app.metadataCache.getFileCache(file);
		if (!cache) continue;
		for (const tag of new Set(getAllTags(cache) ?? [])) {
			const list = byTag.get(tag);
			if (list) list.push(file.path);
			else byTag.set(tag, [file.path]);
		}
	}
	return byTag;
}

/**
 * With no tag: the vault's tags and how many notes carry each. With one: the
 * notes carrying it, including its children — Obsidian's tags are a hierarchy,
 * so #project is meant to cover #project/active.
 */
export function describeTags(
	app: App,
	settings: VaultAssistantSettings,
	tag: string,
	limit: number,
): string {
	const byTag = collect(app, settings);
	if (!byTag.size) return 'No tags in the readable part of this vault.';

	if (!tag) {
		const rows = [...byTag.entries()]
			.sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
			.map(([t, paths]) => `${t} (${paths.length})`);
		return `Tags in this vault, most-used first:\n${rows.join('\n')}`;
	}

	const wanted = (tag.startsWith('#') ? tag : `#${tag}`).toLowerCase();
	const paths = new Set<string>();
	for (const [t, list] of byTag) {
		const lower = t.toLowerCase();
		if (lower === wanted || lower.startsWith(`${wanted}/`)) for (const p of list) paths.add(p);
	}
	if (!paths.size) {
		const near = [...byTag.keys()]
			.filter((t) => t.toLowerCase().includes(wanted.slice(1)))
			.slice(0, 5);
		return near.length
			? `No notes tagged ${wanted}. Similar tags: ${near.join(', ')}.`
			: `No notes tagged ${wanted}. Call tags with no argument to see which tags exist.`;
	}
	const sorted = [...paths].sort((a, b) => a.localeCompare(b));
	const shown = sorted.slice(0, limit);
	const more = sorted.length - shown.length;
	return (
		`${sorted.length} note(s) tagged ${wanted}:\n${shown.join('\n')}` +
		(more ? `\n…(${more} more; raise limit to see them)` : '')
	);
}
