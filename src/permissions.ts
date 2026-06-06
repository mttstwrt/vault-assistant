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

/** Folders the agent is allowed to write into. */
export function writeScopes(s: VaultAssistantSettings): string[] {
	return [...s.writePaths, s.conversationsFolder, s.wikiFolder, s.memoryFile];
}

/** Folders the agent is allowed to read from when scope is restricted. */
export function readScopes(s: VaultAssistantSettings): string[] {
	return [...s.readPaths, s.conversationsFolder, s.wikiFolder, s.memoryFile];
}

export function isWritable(path: string, s: VaultAssistantSettings): boolean {
	return underAny(path, writeScopes(s));
}

export function isReadable(path: string, s: VaultAssistantSettings): boolean {
	if (s.readScope === 'vault') return true;
	return underAny(path, readScopes(s));
}

export function displayScopes(folders: string[]): string {
	const list = folders.map(norm).filter(Boolean);
	return list.length ? list.join(', ') : '(none)';
}
