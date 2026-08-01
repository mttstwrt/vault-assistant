import { App, TFile, WorkspaceLeaf, normalizePath } from 'obsidian';
import { VaultAssistantSettings } from '../settings';
import { isReadable } from '../permissions';

/**
 * What the user currently has open in Obsidian, so "what am I looking at?" and
 * "summarise this note" resolve to a real path without the user naming a file.
 *
 * Blocked folders are respected exactly as everywhere else: their paths are
 * never listed. The one thing that *is* reported is the bare fact that the
 * focused note is blocked — with no path, no name, and no contents — because
 * otherwise the agent would confidently answer about the wrong note.
 */

/** Where an open tab lives, so a real tab is distinguishable from a sidebar preview. */
export type PaneKind = 'main' | 'popout' | 'sidebar';

export interface OpenTab {
	path: string;
	pane: PaneKind;
	pinned: boolean;
	/** The leaf's view type: 'markdown', 'pdf', 'canvas', 'image', … */
	viewType: string;
	/** True for the tab holding the focused file. */
	focused: boolean;
}

export interface OpenFiles {
	/** Readable open tabs, main area first. */
	tabs: OpenTab[];
	/** Path of the focused file, or null when nothing readable is focused. */
	focused: string | null;
	/** A file is focused, but it sits in a blocked folder (path withheld). */
	focusedBlocked: boolean;
	/** How many open tabs were withheld because they are in blocked folders. */
	hidden: number;
}

/** Ordering: the main tab strip first, then pop-out windows, then sidebars. */
const PANE_RANK: Record<PaneKind, number> = { main: 0, popout: 1, sidebar: 2 };

function paneKind(app: App, leaf: WorkspaceLeaf): PaneKind {
	const root = leaf.getRoot();
	if (root === app.workspace.rootSplit) return 'main';
	if (root === app.workspace.leftSplit || root === app.workspace.rightSplit) return 'sidebar';
	return 'popout';
}

/**
 * The file a leaf shows, read from its view state rather than its view: leaves
 * in the background are deferred (Obsidian 1.7+) and have no FileView yet, but
 * their state still carries the path.
 */
function leafFile(app: App, leaf: WorkspaceLeaf): string | null {
	const raw = leaf.getViewState().state?.file;
	if (typeof raw !== 'string' || !raw) return null;
	const path = normalizePath(raw);
	return app.vault.getAbstractFileByPath(path) instanceof TFile ? path : null;
}

/** Snapshot the workspace: every open tab plus the focused file, blocklist applied. */
export function collectOpenFiles(app: App, settings: VaultAssistantSettings): OpenFiles {
	const activeFile = app.workspace.getActiveFile();
	const activePath = activeFile ? activeFile.path : null;
	const focusedVisible = activePath !== null && isReadable(activePath, settings);

	const found: OpenTab[] = [];
	let hidden = 0;
	app.workspace.iterateAllLeaves((leaf) => {
		const path = leafFile(app, leaf);
		if (!path) return;
		if (!isReadable(path, settings)) {
			hidden++;
			return;
		}
		const state = leaf.getViewState();
		found.push({
			path,
			pane: paneKind(app, leaf),
			pinned: state.pinned === true,
			viewType: state.type,
			focused: focusedVisible && path === activePath,
		});
	});

	// Stable order (main area first) and one entry per file, so a note opened in
	// two panes is reported once, under the most prominent one.
	found.sort((a, b) => PANE_RANK[a.pane] - PANE_RANK[b.pane]);
	const tabs: OpenTab[] = [];
	const seen = new Set<string>();
	for (const tab of found) {
		if (seen.has(tab.path)) continue;
		seen.add(tab.path);
		tabs.push(tab);
	}

	return {
		tabs,
		focused: focusedVisible ? activePath : null,
		focusedBlocked: activePath !== null && !focusedVisible,
		hidden,
	};
}

function tabLine(tab: OpenTab): string {
	const notes: string[] = [];
	if (tab.viewType !== 'markdown') notes.push(tab.viewType);
	if (tab.pinned) notes.push('pinned');
	const suffix = notes.length ? ` (${notes.join(', ')})` : '';
	return `- ${tab.path}${suffix}${tab.focused ? '  ← focused' : ''}`;
}

/** The `open_files` tool's output: the full picture of what is on screen. */
export function describeOpenFiles(app: App, settings: VaultAssistantSettings): string {
	const { tabs, focused, focusedBlocked, hidden } = collectOpenFiles(app, settings);
	const lines: string[] = [];

	if (focused) lines.push(`Focused note (what the user is looking at): ${focused}`);
	else if (focusedBlocked) {
		lines.push(
			'Focused note: a note in a blocked folder — hidden from you. If the user means "this note", tell them it is in a folder you cannot read and ask them to paste what they need.',
		);
	} else lines.push('Focused note: (none — no file is open)');

	const groups: [PaneKind, string][] = [
		['main', 'Open tabs'],
		['popout', 'Open in a pop-out window'],
		['sidebar', 'Open in a sidebar'],
	];
	for (const [kind, label] of groups) {
		const group = tabs.filter((t) => t.pane === kind);
		if (!group.length) continue;
		lines.push(`${label}:`);
		for (const tab of group) lines.push(tabLine(tab));
	}
	if (!tabs.length) lines.push('No readable notes are open.');

	if (hidden) {
		lines.push(
			hidden === 1
				? '(1 open tab is in a blocked folder and hidden from you.)'
				: `(${hidden} open tabs are in blocked folders and hidden from you.)`,
		);
	}
	return lines.join('\n');
}

const OPEN_FILES_MARKER = '\n\n--- Open in Obsidian right now (live, refreshed each message) ---';

/** How many non-focused tabs the injected block names before summarising. */
const MAX_LISTED_TABS = 12;

/** Remove a previous turn's open-files block from a system prompt. */
export function stripOpenFiles(systemContent: string): string {
	const i = systemContent.indexOf(OPEN_FILES_MARKER);
	return i === -1 ? systemContent : systemContent.slice(0, i);
}

/**
 * The compact block injected into the system prompt before each message, so the
 * agent always knows what is on screen without spending a tool round on it.
 * Returns '' when there is nothing to report.
 */
export function buildOpenFilesBlock(app: App, settings: VaultAssistantSettings): string {
	if (!settings.useOpenFiles) return '';
	const { tabs, focused, focusedBlocked } = collectOpenFiles(app, settings);
	if (!focused && !focusedBlocked && !tabs.length) return '';

	const lines: string[] = [];
	if (focused) lines.push(`Focused note: ${focused}`);
	else if (focusedBlocked) {
		lines.push('Focused note: in a blocked folder — hidden from you (say so rather than guessing).');
	}

	const others = tabs.filter((t) => !t.focused).map((t) => t.path);
	if (others.length) {
		const listed = others.slice(0, MAX_LISTED_TABS);
		const more = others.length - listed.length;
		lines.push(`Also open: ${listed.join(', ')}${more ? ` (+${more} more)` : ''}`);
	}
	lines.push(
		'When the user says "this note", "what am I looking at", or otherwise means the note in front of them without naming it, they mean the focused note — read it before answering. Call open_files to refresh this list.',
	);

	return `${OPEN_FILES_MARKER}\n${lines.join('\n')}`;
}
