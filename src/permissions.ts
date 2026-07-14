import { normalizePath } from 'obsidian';
import { VaultAssistantSettings } from './settings';

/** Strip leading/trailing slashes so paths compare cleanly. */
function norm(p: string): string {
	return normalizePath(p ?? '').replace(/^\/+|\/+$/g, '');
}

/** True when `path` sits inside (or equals) any of the given folders. */
function underAny(path: string, folders: string[]): boolean {
	const p = norm(path);
	for (const raw of folders) {
		const f = norm(raw);
		if (!f) continue;
		if (p === f || p.startsWith(f + '/')) return true;
	}
	return false;
}

/** The parent folder of a path ('' for a root-level file). */
export function parentFolder(path: string): string {
	return norm(path).split('/').slice(0, -1).join('/');
}

/** Folders the agent's own working files always live in (always read+write). */
function specialFolders(s: VaultAssistantSettings): string[] {
	return [
		s.conversationsFolder,
		s.wikiFolder,
		s.memoryFile,
		s.researchFolder,
		s.workflowsFolder,
		s.goalsFile,
	];
}

/** Folders the agent is allowed to write into. */
export function writeScopes(s: VaultAssistantSettings): string[] {
	return [...s.writePaths, ...specialFolders(s)];
}

/** Folders/files the agent must never see (read blocklist). */
export function blockedReadPaths(s: VaultAssistantSettings): string[] {
	return s.readBlockPaths;
}

export function isWritable(path: string, s: VaultAssistantSettings): boolean {
	return underAny(path, writeScopes(s));
}

/**
 * Reads are default-allow: the agent can read the whole vault except explicitly
 * blocked folders. Its own working folders are always readable, even if a
 * blocked folder would otherwise cover them.
 */
export function isReadable(path: string, s: VaultAssistantSettings): boolean {
	if (underAny(path, specialFolders(s))) return true;
	return !underAny(path, s.readBlockPaths);
}

export function displayScopes(folders: string[]): string {
	const list = folders.map(norm).filter(Boolean);
	return list.length ? list.join(', ') : '(none)';
}
