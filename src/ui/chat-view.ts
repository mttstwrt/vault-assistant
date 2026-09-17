import {
	ItemView,
	Keymap,
	Notice,
	Platform,
	TFile,
	ViewStateResult,
	WorkspaceLeaf,
	WorkspaceWindow,
	setIcon,
} from 'obsidian';
import type VaultAssistantPlugin from '../main';
import { CallStats } from '../api/client';
import { serverContextSize } from '../api/props';
import { ModelEntry, filterModels, listModels, modelOptionLabel } from '../api/models';
import {
	ApprovalRequest,
	ApprovalResult,
	ChatMessage,
	FileChange,
	ExpansionSummary,
	ToolCall,
	TranscriptEntry,
	TurnStats,
} from '../types';
import { serializeDiff, toMessages } from '../transcript';
import { diffLines } from './diff';
import { runAgent } from '../agent';
import { buildSystemPrompt } from '../prompts';
import {
	appendConversation,
	conversationFolders,
	newConversationPath,
	openTranscript,
	saveConversation,
} from '../conversation';
import { ConversationPicker } from './conversation-modal';
import { ImportModal } from './import-modal';
import { WorkflowModal, WorkflowStart } from './workflow-modal';
import { WorkflowRun, createRunNote } from '../workflows/runner';
import { prepareContext, stripPrePass } from '../prepass';
import { Expansion, expandWikilinks } from '../wikilinks';
import { Filing, suggestFiling } from '../filing';
import { buildOpenFilesBlock, stripOpenFiles } from '../tools/workspace';
import { AssistantTurn } from './assistant-turn';
import { fitToContent } from './autogrow';
import { ContextRing } from './context-ring';
import {
	addApprovalRecord,
	addDiffPreview,
	addError,
	addFileChange,
	addInfo,
	addToolCall,
	addToolResult,
	addUserBubble,
	markPreviewApplied,
	prettyJson,
	addExpansionNote,
	addAssistantTurn,
	createPathLink,
} from './message-render';

export const VIEW_TYPE_CHAT = 'vault-assistant-view';

const PLACEHOLDER = 'Ask about your vault…  (Enter to send, Shift+Enter for newline)';

/** How close to the bottom still counts as "following the output", in pixels. */
const FOLLOW_SLACK = 32;

/** Endpoint stats in the shape a transcript keeps, dropping what it does not. */
function toTurnStats(stats: CallStats | undefined): TurnStats | undefined {
	if (!stats) return undefined;
	return {
		elapsedMs: stats.elapsedMs,
		completionTokens: stats.completionTokens,
		tokensPerSecond: stats.tokensPerSecond,
	};
}

/**
 * What the [[link]] expander did, reduced to what the record needs. The text it
 * attached is already in the message; this is the note under the bubble saying
 * so, which a reopened conversation has to be able to draw again.
 */
function summariseExpansion(e: Expansion): ExpansionSummary | undefined {
	if (!e.inlined.length && !e.missed.length && !e.blocked.length && !e.deferred.length) {
		return undefined;
	}
	return {
		inlined: e.inlined.map((i) => {
			const hash = i.link.indexOf('#');
			return {
				path: i.path,
				subpath: hash === -1 ? '' : i.link.slice(hash),
				label: i.label,
				chars: i.chars,
			};
		}),
		missed: e.missed,
		blocked: e.blocked.length,
		deferred: e.deferred,
	};
}

export class ChatView extends ItemView {
	private plugin: VaultAssistantPlugin;
	/**
	 * Everything the panel has shown, in order — the conversation itself. The
	 * message list the endpoint receives is projected from this each turn (see
	 * transcript.toMessages), so there is one record instead of two that drift.
	 */
	private entries: TranscriptEntry[] = [];
	/** Rebuilt per conversation; not part of the record, so never persisted. */
	private systemPrompt = '';
	private conversationPath: string | null = null;
	/** How many entries are already written to a reopened conversation's file. */
	private persistedCount = 0;
	private busy = false;

	private messagesEl!: HTMLElement;
	private statusEl!: HTMLElement;
	private inputEl!: HTMLTextAreaElement;
	private sendBtn!: HTMLButtonElement;
	private modelEl!: HTMLSelectElement;
	private ring!: ContextRing;
	/** The newest turn's numbers, for the footer under a non-streamed answer. */
	private lastStats: CallStats | null = null;
	/** The context window the endpoint reported, or null while it is unknown. */
	private contextTotal: number | null = null;
	/** "baseUrl|model" pairs already re-asked for a window (see retryContextTotal). */
	private contextRetried = new Set<string>();
	private toolEls = new Map<string, HTMLElement>();
	/** Write paths the user approved for the rest of this conversation. */
	private sessionWrites = new Set<string>();
	/** MCP tools the user approved for the rest of this conversation. */
	private sessionMcp = new Set<string>();
	/** Resolvers for approval prompts awaiting a click, so we can cancel them. */
	private pendingApprovals = new Set<(r: ApprovalResult) => void>();
	/** The workflow run this panel is currently hosting, if any. */
	private workflowRun: WorkflowRun | null = null;
	/** Cuts off the answer being streamed (Stop button / Ctrl+C). */
	private abort: AbortController | null = null;
	/** The turn currently streaming in, if any. */
	private turn: AssistantTurn | null = null;
	/** False once the user scrolls up, so streaming output stops yanking the view. */
	private followOutput = true;
	/** True once onOpen has built the panel, so setState knows whether to wait. */
	private mounted = false;
	/** A transcript setState asked for before the panel existed. */
	private pendingPath: string | null = null;
	/** A write the user just approved, whose preview becomes the record of it. */
	private approvedWrite: { path: string; after: string; card: HTMLElement } | null = null;
	/**
	 * True while a save is deciding this conversation's path. Not `busy`,
	 * which turns Send into Stop and there would be nothing to stop — but
	 * sending must still wait, or two writers race on the same new file.
	 */
	private saving = false;

	constructor(leaf: WorkspaceLeaf, plugin: VaultAssistantPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_CHAT;
	}

	getDisplayText(): string {
		return 'Vault assistant';
	}

	getIcon(): string {
		return 'bot';
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass('vault-assistant');

		// The agent can move notes now, and the open conversation's transcript
		// is a note like any other. Without this the panel keeps saving to the
		// path the file left, quietly forking the user's history in two.
		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				if (this.conversationPath === oldPath) this.conversationPath = file.path;
			}),
		);

		const header = root.createDiv({ cls: 'va-header' });
		header.createEl('span', { text: 'Vault assistant', cls: 'va-title' });
		const newBtn = header.createEl('button', { cls: 'va-header-btn', attr: { 'aria-label': 'New chat' } });
		setIcon(newBtn, 'plus');
		newBtn.onclick = () => void this.resetConversation();

		// Always here, even with auto-save on (where it has nothing to do): a
		// button that comes and goes with a setting is harder to find than a
		// redundant one.
		const saveBtn = header.createEl('button', {
			cls: 'va-header-btn',
			attr: { 'aria-label': 'Save conversation' },
		});
		setIcon(saveBtn, 'save');
		saveBtn.onclick = () => void this.saveNow();

		const openBtn = header.createEl('button', {
			cls: 'va-header-btn',
			attr: { 'aria-label': 'Open previous conversation' },
		});
		setIcon(openBtn, 'history');
		openBtn.onclick = () =>
			new ConversationPicker(this.app, this.plugin.settings.conversationsFolder, (f) =>
				void this.openConversation(f),
			).open();

		const importBtn = header.createEl('button', {
			cls: 'va-header-btn',
			attr: { 'aria-label': 'Import conversations' },
		});
		setIcon(importBtn, 'import');
		importBtn.onclick = () => new ImportModal(this.app, this.plugin).open();

		// Popout windows are a desktop feature, and there is nothing to pop out
		// of once the panel is already in its own window.
		if (Platform.isDesktopApp && !this.inPopoutWindow()) {
			const popBtn = header.createEl('button', {
				cls: 'va-header-btn',
				attr: { 'aria-label': 'Move chat to a new window' },
			});
			setIcon(popBtn, 'picture-in-picture-2');
			popBtn.onclick = () => this.popOut();
		}

		const workflowBtn = header.createEl('button', {
			cls: 'va-header-btn',
			attr: { 'aria-label': 'Run workflow' },
		});
		setIcon(workflowBtn, 'telescope');
		workflowBtn.onclick = () => this.openWorkflowModal();

		// Which model is answering, and what else this endpoint serves. The
		// panel and the settings tab share one field, so choosing here is the
		// same act as choosing there.
		this.modelEl = header.createEl('select', {
			cls: 'dropdown va-model',
			attr: { 'aria-label': 'Model' },
		});
		this.renderModelOptions([]);
		this.registerDomEvent(this.modelEl, 'change', () => {
			this.plugin.settings.model = this.modelEl.value;
			// Saving is what re-reads the header, so the ring picks up the new
			// model's context window (see settingsChanged).
			void this.plugin.saveSettings();
		});

		// How full the model's context window is. Both numbers come from the
		// endpoint, so an endpoint that reports neither shows an empty ring
		// rather than a made-up one.
		this.ring = new ContextRing(header);

		this.messagesEl = root.createDiv({ cls: 'va-messages' });

		// MarkdownRenderer marks [[wikilinks]] as internal links but custom views
		// must handle navigation themselves — delegate clicks and hover previews.
		this.registerDomEvent(this.messagesEl, 'click', (evt) => {
			const link = (evt.target as HTMLElement).closest('a.internal-link');
			if (!(link instanceof HTMLElement)) return;
			evt.preventDefault();
			const target = link.getAttr('data-href') ?? link.getAttr('href');
			if (target) void this.app.workspace.openLinkText(target, '', Keymap.isModEvent(evt));
		});
		this.registerDomEvent(this.messagesEl, 'mouseover', (evt) => {
			const link = (evt.target as HTMLElement).closest('a.internal-link');
			if (!(link instanceof HTMLElement)) return;
			this.app.workspace.trigger('hover-link', {
				event: evt,
				source: VIEW_TYPE_CHAT,
				hoverParent: this,
				targetEl: link,
				linktext: link.getAttr('data-href') ?? '',
			});
		});
		// Scrolling up detaches the panel from the stream, so long answers can be
		// read (and selected) while the rest is still being written.
		this.registerDomEvent(this.messagesEl, 'scroll', () => {
			const el = this.messagesEl;
			this.followOutput = el.scrollTop + el.clientHeight >= el.scrollHeight - FOLLOW_SLACK;
		});

		this.statusEl = root.createDiv({ cls: 'va-status' });
		this.setStatus(null);

		const inputRow = root.createDiv({ cls: 'va-input-row' });
		this.inputEl = inputRow.createEl('textarea', {
			cls: 'va-input',
			attr: { rows: '1', placeholder: PLACEHOLDER },
		});
		this.sendBtn = inputRow.createEl('button', { cls: 'va-send', text: 'Send' });

		this.sendBtn.onclick = () => void this.send();
		this.registerDomEvent(this.inputEl, 'keydown', (evt) => {
			// isComposing guards IME input, where Enter commits a candidate.
			if (evt.key === 'Enter' && !evt.shiftKey && !evt.isComposing) {
				evt.preventDefault();
				void this.send();
			}
		});
		// Grow the composer with its content, up to the height CSS allows.
		this.registerDomEvent(this.inputEl, 'input', () => fitToContent(this.inputEl));
		fitToContent(this.inputEl);

		// Ctrl+C stops the answer being generated, the way it does in a terminal.
		this.registerDomEvent(this.containerEl, 'keydown', (evt) => {
			if (evt.key.toLowerCase() !== 'c' || !evt.ctrlKey || evt.metaKey || evt.altKey) return;
			if (!this.busy || this.hasSelection()) return;
			evt.preventDefault();
			this.interrupt();
		});

		this.mounted = true;
		this.refreshContextTotal();
		this.loadModelOptions();
		// Continue the conversation this panel was showing before it moved
		// windows (or before Obsidian restarted); otherwise start fresh.
		const pending = this.pendingPath;
		this.pendingPath = null;
		if (pending && (await this.loadConversationPath(pending))) return;
		await this.resetConversation();
	}

	async onClose(): Promise<void> {
		this.mounted = false;
		this.abort?.abort();
		this.abort = null;
		this.turn?.dispose();
		this.turn = null;
		this.workflowRun?.stop();
		this.cancelPendingApprovals();
		this.toolEls.clear();
	}

	/** True while a message or workflow run is in flight. */
	isBusy(): boolean {
		return this.busy;
	}

	/**
	 * The endpoint or the model may have been changed in settings while this
	 * panel was open; the header shows both, so it re-reads both.
	 */
	settingsChanged(): void {
		if (!this.mounted) return;
		this.refreshContextTotal();
		this.loadModelOptions();
	}

	/** Offer the models this endpoint advertises. Failure leaves the current one. */
	private loadModelOptions(): void {
		const { baseUrl, apiKey } = this.plugin.settings;
		void listModels(baseUrl, apiKey)
			.then((models) => {
				if (this.mounted) this.renderModelOptions(filterModels(models, 'chat'));
			})
			.catch((e: unknown) => {
				// The settings tab is where a discovery failure gets explained;
				// the header just keeps showing the configured model.
				console.debug('[vault-assistant] No model list for the panel:', e);
				if (this.mounted) this.renderModelOptions([]);
			});
	}

	/**
	 * Fill the model selector. The configured model is always offered, even
	 * when the endpoint doesn't list it, so picking from the list is never a
	 * one-way door out of a hand-typed name.
	 */
	private renderModelOptions(models: ModelEntry[]): void {
		const current = this.plugin.settings.model;
		const offered = models.some((m) => m.id === current)
			? models
			: [{ id: current }, ...models];

		this.modelEl.empty();
		for (const model of offered) {
			const text = model.id ? modelOptionLabel(model) : '(no model set)';
			this.modelEl.createEl('option', { value: model.id, text });
		}
		this.modelEl.value = current;
		// The header is too narrow for a long name, and the open list is where
		// the readiness marker gets read anyway; hovering gives the whole label.
		const chosen = offered.find((m) => m.id === current);
		this.modelEl.setAttr('title', chosen && chosen.id ? modelOptionLabel(chosen) : 'No model set');
	}

	/**
	 * Ask the endpoint how big this model's context window is. llama.cpp
	 * answers; most don't, and the ring says so rather than guessing.
	 */
	private refreshContextTotal(refresh = false): void {
		const { baseUrl, apiKey, model } = this.plugin.settings;
		void serverContextSize(baseUrl, apiKey, model, refresh).then((total) => {
			this.contextTotal = total;
			if (this.mounted) this.ring.setTotal(total);
		});
	}

	/**
	 * Ask again for a context window that came back unknown, now that a turn
	 * has landed. On a llama.cpp router the first lookup asks with
	 * `autoload=false`, so a model that was not resident reported nothing — and
	 * an answer is proof that it is resident now. Once per endpoint and model,
	 * because an endpoint that simply has no /props would otherwise be re-asked
	 * after every turn forever.
	 */
	private retryContextTotal(): void {
		if (this.contextTotal !== null) return;
		const { baseUrl, model } = this.plugin.settings;
		const key = `${baseUrl}|${model}`;
		if (this.contextRetried.has(key)) return;
		this.contextRetried.add(key);
		this.refreshContextTotal(true);
	}

	/** Whether this panel is already living in its own window. */
	private inPopoutWindow(): boolean {
		try {
			return this.leaf.getContainer() instanceof WorkspaceWindow;
		} catch {
			// A leaf with no container yet is, by definition, not in a popout.
			return false;
		}
	}

	/**
	 * Move the panel into its own window. Obsidian rebuilds the view there, so
	 * the conversation travels as view state (see getState/setState) and is read
	 * back from its saved transcript.
	 */
	private popOut(): void {
		if (this.busy || this.saving) {
			this.busyNotice();
			return;
		}
		// The transcript is what travels, so without one the new window starts
		// a fresh conversation. Say so rather than silently dropping it.
		if (!this.conversationPath && this.entries.length) {
			new Notice(
				'This conversation has not been saved, so it cannot follow the panel to a new window. Save it first.',
			);
		}
		try {
			this.app.workspace.moveLeafToPopout(this.leaf);
		} catch (e) {
			new Notice(`Could not open a new window: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	/**
	 * Remember which transcript is open, so the conversation survives being
	 * moved to another window (and comes back when Obsidian restores the
	 * workspace). Only the path travels — the transcript itself stays in the
	 * vault instead of being copied into workspace.json.
	 */
	getState(): Record<string, unknown> {
		return { ...super.getState(), conversationPath: this.conversationPath };
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		await super.setState(state, result);
		const path = (state as { conversationPath?: unknown } | null)?.conversationPath;
		if (typeof path !== 'string' || !path || path === this.conversationPath) return;
		// State can arrive before the panel is built; onOpen picks it up then.
		if (!this.mounted) {
			this.pendingPath = path;
			return;
		}
		await this.loadConversationPath(path);
	}

	/** Open the transcript at `path`, if it is still there. */
	private async loadConversationPath(path: string): Promise<boolean> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return false;
		await this.openConversation(file);
		return true;
	}

	/** Stop the streaming answer, or the workflow run, in progress. */
	interrupt(): void {
		if (this.workflowRun) {
			this.workflowRun.stop();
			this.sendBtn.disabled = true;
			this.sendBtn.setText('Stopping…');
			return;
		}
		if (!this.abort || this.abort.signal.aborted) return;
		this.abort.abort();
		this.setStatus('Stopping…');
	}

	/** Whether the user has text selected here — then Ctrl+C means "copy". */
	private hasSelection(): boolean {
		if (
			this.containerEl.doc.activeElement === this.inputEl &&
			this.inputEl.selectionStart !== this.inputEl.selectionEnd
		) {
			return true;
		}
		const selection = this.containerEl.win.getSelection();
		if (!selection || selection.isCollapsed) return false;
		// A leftover selection elsewhere in the app must not block stopping.
		const node = selection.anchorNode;
		return !!node && this.containerEl.contains(node);
	}

	private busyNotice(): void {
		new Notice(
			this.saving
				? 'Saving this conversation — try again in a moment.'
				: 'Wait for the current response to finish, or stop it with Ctrl+C.',
		);
	}

	/**
	 * Drop everything conversation-scoped and start a fresh system prompt.
	 * Says nothing on screen: a chat announces itself, a workflow run announces
	 * the run instead, so the banner belongs to the caller.
	 */
	private async clearConversation(): Promise<void> {
		this.cancelPendingApprovals();
		this.systemPrompt = await buildSystemPrompt(this.app, this.plugin.settings);
		this.entries = [];
		this.conversationPath = null;
		this.persistedCount = 0;
		this.lastStats = null;
		this.toolEls.clear();
		this.sessionWrites.clear();
		this.sessionMcp.clear();
		this.messagesEl.empty();
		this.followOutput = true;
		this.ring.reset();
	}

	private async resetConversation(): Promise<void> {
		if (this.busy || this.saving) {
			this.busyNotice();
			return;
		}
		await this.clearConversation();
		addInfo(
			this.messagesEl,
			'New conversation. The agent can read and (within allowed folders) write your vault.',
		);
	}

	/** Load a saved transcript back into the chat so it can be continued. */
	private async openConversation(file: TFile): Promise<void> {
		if (this.busy || this.saving) {
			this.busyNotice();
			return;
		}
		await this.clearConversation();
		this.entries = openTranscript(await this.app.vault.cachedRead(file));
		this.conversationPath = file.path;
		this.persistedCount = this.entries.length;
		const resumed = addInfo(this.messagesEl, 'Continuing ');
		createPathLink(this.app, resumed, file.path, file.basename);
		await this.renderEntries(this.entries);
		this.scrollToBottom(true);
	}

	/**
	 * Redraw the panel from the record. The same functions the live conversation
	 * calls, in the same order, so a reopened conversation looks like the one you
	 * closed rather than a summary of it.
	 */
	private async renderEntries(entries: TranscriptEntry[]): Promise<void> {
		for (const entry of entries) {
			switch (entry.kind) {
				case 'user': {
					const bubble = addUserBubble(this.messagesEl, entry.text);
					if (entry.attached) addExpansionNote(this.app, bubble, entry.attached);
					break;
				}
				case 'assistant': {
					if (!entry.text.trim() && !entry.reasoning) break;
					await addAssistantTurn(this.app, this, this.messagesEl, entry);
					break;
				}
				case 'tool': {
					const details = addToolCall(this.messagesEl, entry.call);
					addToolResult(details, entry.result);
					break;
				}
				case 'change':
					addFileChange(this.app, this.messagesEl, entry);
					break;
				case 'approval':
					addApprovalRecord(this.app, this.messagesEl, entry.request, entry.decision);
					break;
				case 'error':
					addError(this.messagesEl, entry.message);
					break;
			}
		}
	}

	/**
	 * Append to the record.
	 *
	 * A workflow run is shown here but is not this conversation: its memory is
	 * the run note, it builds its own per-round history, and none of it should
	 * become context for whatever you type in the panel afterwards. So a run
	 * draws without recording.
	 */
	private record(entry: TranscriptEntry): void {
		if (this.workflowRun) return;
		this.entries.push(entry);
	}

	/** Resolve any approval prompts still awaiting a click as denials. */
	private cancelPendingApprovals(): void {
		for (const resolve of this.pendingApprovals) resolve('deny');
		this.pendingApprovals.clear();
		this.approvedWrite = null;
	}

	/** Render an approval card and resolve when the user picks an option. */
	private requestApproval(req: ApprovalRequest): Promise<ApprovalResult> {
		return new Promise<ApprovalResult>((resolve) => {
			this.pendingApprovals.add(resolve);
			/** The diff shown for a pending write, relabelled once it is applied. */
			let preview: HTMLElement | null = null;

			const card = this.messagesEl.createDiv({ cls: 'va-approval' });
			const head = card.createDiv({ cls: 'va-approval-head' });
			setIcon(head.createSpan({ cls: 'va-approval-icon' }), 'shield-alert');
			head.createSpan({ text: req.kind === 'mcp' ? ' External tool call' : ' Approval required' });
			if (req.kind === 'move' || req.kind === 'create-folder') {
				card.createDiv({
					cls: 'va-approval-body',
					text:
						req.kind === 'move'
							? `The agent wants to move something outside your allowed folders (via ${req.tool}):`
							: `The agent wants to create a folder outside your allowed folders (via ${req.tool}):`,
				});
				const line = card.createEl('code', { cls: 'va-approval-path' });
				createPathLink(this.app, line, req.path ?? '');
				if (req.kind === 'move') {
					line.appendText('  →  ');
					createPathLink(this.app, line, req.toPath ?? '');
				}
			} else if (req.kind === 'mcp') {
				card.createDiv({
					cls: 'va-approval-body',
					text: `The agent wants to call an external MCP tool on "${req.serverName}":`,
				});
				card.createEl('code', { cls: 'va-approval-path', text: req.tool });
				if (req.args && req.args !== '{}') {
					card.createEl('pre', { cls: 'va-approval-args', text: prettyJson(req.args) });
				}
			} else {
				card.createDiv({
					cls: 'va-approval-body',
					text: `The agent wants to write outside your allowed folders (via ${req.tool}):`,
				});
				createPathLink(this.app, card.createEl('code', { cls: 'va-approval-path' }), req.path ?? '');
				// Decide on the actual change, not just the path.
				if (req.preview) {
					preview = addDiffPreview(
						card,
						serializeDiff(diffLines(req.preview.before, req.preview.after)),
						!req.preview.before,
					);
				}
			}

			const row = card.createDiv({ cls: 'va-approval-actions' });
			const settle = (result: ApprovalResult, label: string): void => {
				if (!this.pendingApprovals.has(resolve)) return;
				this.pendingApprovals.delete(resolve);
				// An allowed write happens next; its diff is already on screen.
				if (preview && req.preview && result !== 'deny') {
					this.approvedWrite = { path: req.path ?? '', after: req.preview.after, card: preview };
				}
				row.empty();
				card.addClass('va-approval-done');
				card.createDiv({ cls: 'va-approval-choice', text: `→ ${label}` });
				// What you allowed is part of what happened, so it is recorded
				// rather than living only on the card that asked.
				this.record({ kind: 'approval', request: req, decision: result });
				this.scrollToBottom();
				resolve(result);
			};
			const addBtn = (label: string, result: ApprovalResult, cls: string): void => {
				const b = row.createEl('button', { cls: `va-approval-btn ${cls}`, text: label });
				b.onclick = () => settle(result, label);
			};

			addBtn('Deny', 'deny', 'va-deny');
			addBtn('Allow once', 'once', 'va-once');
			addBtn('Allow for session', 'session', 'va-session');
			if (req.kind === 'mcp') {
				addBtn(`Always trust ${req.serverName}`, 'always-trust', 'va-always');
			} else {
				// "This file" means nothing when the thing being made IS a folder.
				if (req.kind !== 'create-folder') addBtn('Always: this file', 'always-file', 'va-always');
				if (req.folder) addBtn(`Always: ${req.folder}/`, 'always-folder', 'va-always');
			}

			// An approval needs an answer, so always bring it into view.
			this.scrollToBottom(true);
		});
	}

	/** Scroll to the newest output, unless the user has scrolled up to read. */
	private scrollToBottom(force = false): void {
		if (!force && !this.followOutput) return;
		this.followOutput = true;
		this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
	}

	/** The one-line "what is happening" strip above the composer. */
	private setStatus(text: string | null): void {
		// While an answer can still be cut off, say how.
		const stoppable = !!this.abort && !this.abort.signal.aborted;
		this.statusEl.setText(text ? `${text}${stoppable ? ' · Ctrl+C to stop' : ''}` : '');
		this.statusEl.toggleClass('va-hidden', !text);
	}

	/**
	 * A finished answer that was not streamed — a buffered turn, or a saved
	 * transcript being reopened. `live` turns mean "this just came off the
	 * endpoint", which is what earns the stats line a streamed turn gets from
	 * AssistantTurn; a replayed transcript carries no timings to report.
	 */
	private async addAssistantBubble(markdown: string, reasoning?: string): Promise<void> {
		const entry: TranscriptEntry = {
			kind: 'assistant',
			text: markdown,
			reasoning: reasoning || undefined,
			stats: toTurnStats(this.lastStats ?? undefined),
		};
		this.record(entry);
		await addAssistantTurn(this.app, this, this.messagesEl, entry);
		this.scrollToBottom();
	}

	private addToolCall(call: ToolCall): void {
		this.toolEls.set(call.id, addToolCall(this.messagesEl, call));
		this.setStatus(`Running ${call.name}…`);
		this.scrollToBottom();
	}

	private addToolResult(call: ToolCall, result: string): void {
		// The full result, not the truncated view of it: this is the model's
		// context on the next turn, so shortening it here would change the
		// conversation rather than how it is drawn.
		this.record({ kind: 'tool', call, result });
		const details = this.toolEls.get(call.id);
		if (!details) return;
		addToolResult(details, result);
		this.setStatus('Thinking…');
		this.scrollToBottom();
	}

	/**
	 * Show what a write actually changed, as a diff.
	 *
	 * The diff is computed once, here, and kept in that form: it is what was on
	 * screen, and the file's before and after are not — storing those would put
	 * a second copy of every note the agent touches into the conversations
	 * folder, and they cannot be recovered when the note changes again.
	 */
	private addFileChange(change: FileChange): void {
		const entry: TranscriptEntry = {
			kind: 'change',
			path: change.path,
			change: change.kind,
			diff: serializeDiff(diffLines(change.before, change.after)),
		};
		this.record(entry);

		const approved = this.approvedWrite;
		if (approved && approved.path === change.path && approved.after === change.after) {
			// This is the write the approval card already previewed.
			markPreviewApplied(this.app, approved.card, entry);
			this.approvedWrite = null;
			return;
		}
		addFileChange(this.app, this.messagesEl, entry);
		this.scrollToBottom();
	}

	private addError(message: string): void {
		this.record({ kind: 'error', message });
		addError(this.messagesEl, message);
		this.scrollToBottom();
	}

	/**
	 * Toggle the panel for work in flight: Send becomes Stop, and the model
	 * selector locks — swapping models between the tool rounds of one message,
	 * or between the steps of one run, would split that work across two of them.
	 *
	 * A run additionally locks the composer, because there is no turn for a
	 * typed message to join; during a chat answer the composer stays live so the
	 * next message can be written while this one finishes.
	 */
	private setBusy(busy: boolean, mode: 'chat' | 'run' = 'chat'): void {
		this.busy = busy;
		this.modelEl.disabled = busy;
		const locked = busy && mode === 'run';
		this.inputEl.disabled = locked;
		this.inputEl.placeholder = locked ? 'Workflow run in progress…' : PLACEHOLDER;
		this.sendBtn.disabled = false;
		this.sendBtn.setText(busy ? 'Stop' : 'Send');
		this.sendBtn.toggleClass('va-stop', busy);
		this.sendBtn.onclick = busy ? () => this.interrupt() : () => void this.send();
	}

	/**
	 * Where this conversation's transcript goes. With naming or filing on, one
	 * extra cheap model call turns the opening exchange into a title and the
	 * name of a folder to keep it under; both settings share that one call, and
	 * whichever half it fails to answer falls back to the first message and the
	 * root of the conversations folder, as before.
	 */
	private async newConversationPath(firstMessage: string, interrupted: boolean): Promise<string> {
		const s = this.plugin.settings;
		let filed: Filing = { title: '', folder: '' };
		// Don't spend a call right after the user hit Stop, or on a turn that
		// produced nothing to name.
		if ((s.nameConversations || s.fileConversations) && !interrupted) {
			const answer = this.lastAssistantContent();
			if (answer) {
				this.setStatus(
					s.nameConversations ? 'Naming the conversation…' : 'Filing the conversation…',
				);
				filed = await suggestFiling(s, firstMessage, answer, {
					title: s.nameConversations,
					folders: s.fileConversations ? conversationFolders(this.app, s) : null,
				});
			}
		}
		return newConversationPath(this.app, s, filed.title || firstMessage, filed.folder);
	}

	/** The most recent assistant answer in this conversation, if any. */
	private lastAssistantContent(): string {
		for (let i = this.entries.length - 1; i >= 0; i--) {
			const e = this.entries[i];
			if (e?.kind === 'assistant' && e.text.trim()) return e.text;
		}
		return '';
	}

	private async send(): Promise<void> {
		if (this.busy || this.saving) return;
		const text = this.inputEl.value.trim();
		if (!text) return;

		this.inputEl.value = '';
		fitToContent(this.inputEl);
		const bubble = addUserBubble(this.messagesEl, text);
		this.scrollToBottom(true);

		// Busy before the first await, not after: expanding links reads notes,
		// and until this is set a second Enter re-enters send() and sends the
		// same turn twice.
		const abort = new AbortController();
		this.abort = abort;
		this.setBusy(true);
		this.setStatus('Thinking…');

		// A [[link]] the user typed is an unambiguous "this note, please", so it
		// is resolved here and attached to the message rather than costing the
		// agent a tool round. It goes into history, not the system prompt: the
		// note is still the subject several turns later, and a reopened
		// transcript has to give the model the context it had the first time.
		const expansion = this.plugin.settings.expandTypedLinks
			? await expandWikilinks(this.app, this.plugin.settings, text, this.linkSourcePath())
			: null;
		const attached = expansion ? summariseExpansion(expansion) : undefined;
		if (attached) {
			addExpansionNote(this.app, bubble, attached);
			this.scrollToBottom();
		}
		this.record({ kind: 'user', text, block: expansion?.block || undefined, attached });

		// Both blocks are rebuilt from scratch each turn, so stale tabs and last
		// turn's pre-fetched context never pile up. Order matters: the strippers
		// cut from their marker to the end.
		let system = stripOpenFiles(stripPrePass(this.systemPrompt));
		system += buildOpenFilesBlock(this.app, this.plugin.settings);
		if (this.plugin.settings.usePrePass && !abort.signal.aborted) {
			this.setStatus('Preparing context…');
			const block = await prepareContext(this.app, this.plugin.settings, this.plugin.rag, text);
			if (block) system += block;
			this.setStatus('Thinking…');
		}

		// The wire history is derived rather than kept: one record, projected
		// for the endpoint each turn. runAgent appends to this array as it runs,
		// and those turns reach the record through the events below.
		const history: ChatMessage[] = [
			{ role: 'system', content: system },
			...toMessages(this.entries),
		];

		/** Set when a streamed turn already showed that it was cut short. */
		let stopShown = false;

		if (!abort.signal.aborted) {
			await runAgent(
				this.app,
				this.plugin.settings,
				() => this.plugin.saveSettings(),
				this.plugin.mcp,
				this.plugin.rag,
				this.sessionWrites,
				this.sessionMcp,
				history,
				{
					onAssistant: (c, reasoning) => void this.addAssistantBubble(c, reasoning),
					onToolCall: (call) => this.addToolCall(call),
					onToolResult: (call, res) => this.addToolResult(call, res),
					onError: (msg) => this.addError(msg),
					onFileChange: (change) => this.addFileChange(change),
					onStats: (stats) => {
						this.lastStats = stats;
						this.ring.report(stats);
						this.retryContextTotal();
						// While a turn is still streaming these arrive per chunk
						// (llama.cpp only), so the speed is worth showing as it is
						// measured rather than once the answer has stopped.
						if (this.turn && stats.tokensPerSecond) {
							this.setStatus(`Generating… ${stats.tokensPerSecond.toFixed(1)} tok/s`);
						}
					},
					requestApproval: (req) => this.requestApproval(req),
					stream: {
						onStart: () => {
							this.setStatus('Generating…');
							this.turn = new AssistantTurn(this.app, this, this.messagesEl, {
								expandThinking: this.plugin.settings.expandThinking,
								onGrow: () => this.scrollToBottom(),
							});
						},
						onContent: (delta) => this.turn?.pushContent(delta),
						onReasoning: (delta) => this.turn?.pushReasoning(delta),
						onReclassify: () => this.turn?.reclassifyAsReasoning(),
						onDone: (info) => {
							const turn = this.turn;
							this.turn = null;
							if (!turn) return;
							if (info.aborted && turn.hasOutput()) stopShown = true;
							const { text, reasoning, thoughtMs } = turn.record();
							this.record({
								kind: 'assistant',
								text,
								reasoning,
								thoughtMs,
								stats: toTurnStats(info.stats),
								aborted: info.aborted || undefined,
							});
							void turn.finish(info);
						},
					},
				},
				{ signal: abort.signal },
			);
		}

		if (abort.signal.aborted && !stopShown) addInfo(this.messagesEl, 'Stopped.');
		this.lastStats = null;

		// A conversation that already has a file keeps it current, whatever
		// auto-save says: the setting decides whether a transcript is created
		// without being asked, not whether one that exists stays true. Saving
		// here, before the panel unblocks, keeps the naming call inside the
		// busy window so a new message cannot arrive mid-decision.
		if (this.plugin.settings.autoSaveConversations || this.conversationPath) {
			await this.persistConversation(abort.signal.aborted);
		}

		this.abort = null;
		this.setStatus(null);
		this.setBusy(false);
	}

	/**
	 * The note a typed [[link]] resolves against, so it lands where it would if
	 * written in the note the user is looking at. Empty when "See what you have
	 * open" is off: that setting means the panel does not use what is open, and
	 * quietly using it for link resolution would route around it.
	 */
	private linkSourcePath(): string {
		if (!this.plugin.settings.useOpenFiles) return '';
		return this.app.workspace.getActiveFile()?.path ?? '';
	}

	/** The message that opened this conversation — what names and files it. */
	private firstUserMessage(): string {
		const first = this.entries.find((e) => e.kind === 'user');
		return first?.kind === 'user' ? first.text : '';
	}

	/**
	 * Write the conversation to its transcript, naming and filing it on the
	 * first save. Shared by auto-save and the save button, so a conversation
	 * saved by hand is the same file auto-save would have written. Returns the
	 * path, or null when there was nothing to save.
	 */
	private async persistConversation(interrupted = false): Promise<string | null> {
		let path = this.conversationPath;
		if (!path) {
			// Named once, from the opening exchange — the answer says what the
			// conversation turned out to be about better than the question does.
			const first = this.firstUserMessage();
			if (!first) return null;
			path = await this.newConversationPath(first, interrupted);
			this.conversationPath = path;
		}
		try {
			if (this.persistedCount > 0) {
				// Reopened conversation: append only what is new, so the original
				// file is preserved as saved.
				await appendConversation(this.app, path, this.entries.slice(this.persistedCount));
			} else {
				await saveConversation(this.app, this.plugin.settings, path, this.entries);
			}
			this.persistedCount = this.entries.length;
			return path;
		} catch (e) {
			new Notice(`Could not save conversation: ${e instanceof Error ? e.message : String(e)}`);
			return null;
		}
	}

	/**
	 * Save the open conversation now, whatever auto-save says. From here on it
	 * has a file, so later turns keep that file current — a transcript that
	 * stops three turns short while looking complete is worse than none.
	 */
	private async saveNow(): Promise<void> {
		if (this.busy) {
			this.busyNotice();
			return;
		}
		// A second click while the first is still deciding a path.
		if (this.saving) return;
		if (!this.firstUserMessage()) {
			new Notice('Nothing to save yet.');
			return;
		}
		this.saving = true;
		this.setStatus('Saving…');
		try {
			const path = await this.persistConversation();
			if (path) new Notice(`Saved to ${path}`);
		} finally {
			this.saving = false;
			this.setStatus(null);
		}
	}

	/** Open the workflow modal (also reachable via the "Run workflow" command). */
	openWorkflowModal(): void {
		if (this.busy) {
			this.busyNotice();
			return;
		}
		new WorkflowModal(this.app, this.plugin, (start) => void this.startWorkflow(start)).open();
	}

	/** Host an autonomous workflow run in this panel until it pauses or finishes. */
	async startWorkflow(start: WorkflowStart): Promise<void> {
		if (this.busy) {
			this.busyNotice();
			return;
		}
		// The run builds its own per-round context; clear the panel so any chat
		// afterwards starts from a clean conversation. The run's transcript is
		// not saved as a conversation — the run note is the artifact.
		await this.clearConversation();

		let path: string;
		try {
			path = start.file
				? start.file.path
				: await createRunNote(this.app, this.plugin.settings, start.workflow, start.goal);
		} catch (e) {
			this.addError(`Could not start the run: ${e instanceof Error ? e.message : String(e)}`);
			return;
		}

		const budget = start.maxRounds > 0 ? `${start.maxRounds} rounds` : 'until stopped';
		addInfo(
			this.messagesEl,
			start.file
				? `Resuming "${start.file.basename}" with ${start.workflow.name} (${budget}).`
				: `${start.workflow.name} (${budget}): ${start.goal}`,
		);
		const saved = addInfo(this.messagesEl, 'Progress is saved to ');
		createPathLink(this.app, saved, path);

		this.setBusy(true, 'run');
		this.setStatus('Workflow run in progress…');
		this.workflowRun = new WorkflowRun(
			this.app,
			this.plugin.settings,
			() => this.plugin.saveSettings(),
			this.plugin.mcp,
			this.plugin.rag,
			start.workflow,
			{ path, maxRounds: start.maxRounds, delaySeconds: start.delaySeconds },
			{
				onAssistant: (c, reasoning) => void this.addAssistantBubble(c, reasoning),
				onToolCall: (call) => this.addToolCall(call),
				onToolResult: (call, res) => this.addToolResult(call, res),
				onError: (msg) => this.addError(msg),
				onFileChange: (change) => this.addFileChange(change),
				onInfo: (text) => {
					addInfo(this.messagesEl, text);
					this.scrollToBottom();
				},
				requestApproval: (req) => this.requestApproval(req),
			},
		);
		try {
			await this.workflowRun.run();
		} catch (e) {
			this.addError(`Run failed: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			this.workflowRun = null;
			this.setBusy(false, 'run');
			this.setStatus(null);
		}
	}

}
