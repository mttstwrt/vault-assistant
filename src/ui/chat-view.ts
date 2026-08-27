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
import { ReasoningEffort, effortLabel } from '../settings';
import {
	COMMON_EFFORT_LEVELS,
	EFFORT_LEVELS,
	EffortSupport,
	clearServerFacts,
	serverFacts,
} from '../api/props';
import { discoverModels, filterModels, modelLabel } from '../api/models';
import { ApprovalRequest, ApprovalResult, ChatMessage, FileChange, ToolCall } from '../types';
import { runAgent } from '../agent';
import { buildSystemPrompt } from '../prompts';
import {
	appendConversation,
	newConversationPath,
	parseConversation,
	saveConversation,
} from '../conversation';
import { ConversationPicker, askUnsavedChat } from './conversation-modal';
import { ImportModal } from './import-modal';
import { WorkflowModal, WorkflowStart } from './workflow-modal';
import { WorkflowRun, createRunNote } from '../workflows/runner';
import { prepareContext, stripPrePass } from '../prepass';
import { suggestConversationTitle } from '../title';
import { buildOpenFilesBlock, stripOpenFiles } from '../tools/workspace';
import { AssistantTurn } from './assistant-turn';
import { ThinkingSection } from './thinking';
import { ContextRing } from './context-ring';
import { fitToContent } from './autogrow';
import {
	addAssistantBubble,
	addDiffPreview,
	addError,
	addFileChange,
	addInfo,
	addToolCall,
	addToolResult,
	addUserBubble,
	markPreviewApplied,
	prettyJson,
} from './message-render';

export const VIEW_TYPE_CHAT = 'vault-assistant-view';

const PLACEHOLDER = 'Ask about your vault…  (Enter to send, Shift+Enter for newline)';

/** How close to the bottom still counts as "following the output", in pixels. */
const FOLLOW_SLACK = 32;

export class ChatView extends ItemView {
	private plugin: VaultAssistantPlugin;
	private history: ChatMessage[] = [];
	private conversationPath: string | null = null;
	/** How many history entries are already saved in a reopened conversation's file. */
	private persistedCount = 0;
	private busy = false;

	private messagesEl!: HTMLElement;
	private statusEl!: HTMLElement;
	private statusTextEl!: HTMLElement;
	private contextRing!: ContextRing;
	/** What the status strip is saying, so the ring can redraw without it. */
	private statusText: string | null = null;
	/** The window the endpoint reported, and the prompt it last counted. */
	private contextSize: number | null = null;
	private promptTokens: number | null = null;
	private inputEl!: HTMLTextAreaElement;
	private modelEl!: HTMLSelectElement;
	private effortEl!: HTMLSelectElement;
	private sendBtn!: HTMLButtonElement;
	private saveBtn!: HTMLButtonElement;
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
	/** The pre-pass's own thinking section, while one is running. */
	private prepass: ThinkingSection | null = null;
	/**
	 * What the last pre-pass collected. Kept across turns: a pass that skips has
	 * decided the answer already has what it needs, and the notes it means are
	 * these — dropping them would answer the follow-up with the material gone.
	 */
	private prePassBlock: string | null = null;
	/** False once the user scrolls up, so streaming output stops yanking the view. */
	private followOutput = true;
	/** True once onOpen has built the panel, so setState knows whether to wait. */
	private mounted = false;
	/** A transcript setState asked for before the panel existed. */
	private pendingPath: string | null = null;
	/** A write the user just approved, whose preview becomes the record of it. */
	private approvedWrite: { path: string; after: string; card: HTMLElement } | null = null;

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

		const header = root.createDiv({ cls: 'va-header' });
		header.createEl('span', { text: 'Vault assistant', cls: 'va-title' });
		const newBtn = header.createEl('button', { cls: 'va-new', attr: { 'aria-label': 'New chat' } });
		setIcon(newBtn, 'plus');
		newBtn.onclick = () => void this.resetConversation();

		const openBtn = header.createEl('button', {
			cls: 'va-new',
			attr: { 'aria-label': 'Open previous conversation' },
		});
		setIcon(openBtn, 'history');
		openBtn.onclick = () =>
			new ConversationPicker(this.app, this.plugin.settings.conversationsFolder, (f) =>
				void this.openConversation(f),
			).open();

		// Conversations are not written to the vault unless asked for, so this is
		// how one becomes a note. After the first press the file keeps up with
		// the panel on its own, and the button has nothing left to do.
		this.saveBtn = header.createEl('button', {
			cls: 'va-new',
			attr: { 'aria-label': 'Save this conversation' },
		});
		setIcon(this.saveBtn, 'save');
		this.saveBtn.onclick = () => void this.saveConversation();

		const importBtn = header.createEl('button', {
			cls: 'va-new',
			attr: { 'aria-label': 'Import conversations' },
		});
		setIcon(importBtn, 'import');
		importBtn.onclick = () => new ImportModal(this.app, this.plugin).open();

		// Popout windows are a desktop feature, and there is nothing to pop out
		// of once the panel is already in its own window.
		if (Platform.isDesktopApp && !this.inPopoutWindow()) {
			const popBtn = header.createEl('button', {
				cls: 'va-new',
				attr: { 'aria-label': 'Move chat to a new window' },
			});
			setIcon(popBtn, 'picture-in-picture-2');
			popBtn.onclick = () => void this.popOut();
		}

		const workflowBtn = header.createEl('button', {
			cls: 'va-new',
			attr: { 'aria-label': 'Run workflow' },
		});
		setIcon(workflowBtn, 'telescope');
		workflowBtn.onclick = () => this.openWorkflowModal();

		// The two dropdowns wrap as a pair: on a narrow panel they take a line
		// of their own together, rather than the model staying up with the
		// buttons and leaving the effort selector stranded below it.
		const controls = header.createDiv({ cls: 'va-controls' });

		// Which model answers. The endpoint's own list when it has one, and
		// always the configured name — an endpoint that can't list models still
		// shows what it is set to rather than going blank.
		this.modelEl = controls.createEl('select', {
			cls: 'dropdown va-model',
			attr: {
				'aria-label': 'Model',
				title: 'The model this chat sends to. The endpoint that serves it is set in settings.',
			},
		});
		this.renderModelOptions([]);
		this.registerDomEvent(this.modelEl, 'change', () => void this.applyModel(this.modelEl.value));
		this.refreshModels();

		// How hard the model should think. "Default" sends nothing, so endpoints
		// that don't know reasoning_effort never see it.
		this.effortEl = controls.createEl('select', {
			cls: 'dropdown va-effort',
			attr: {
				'aria-label': 'Reasoning effort',
				title: 'How hard a reasoning model should think (sent as reasoning_effort). Lower it when a model gets stuck thinking.',
			},
		});
		this.renderEffortOptions({ kind: 'unknown' });
		this.registerDomEvent(this.effortEl, 'change', () => {
			this.plugin.settings.reasoningEffort = this.effortEl.value as ReasoningEffort;
			void this.plugin.saveSettings();
		});
		// Narrow the list to what this model actually understands, if the
		// endpoint is willing to say (llama.cpp is; most aren't).
		this.refreshServerFacts();

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

		// The strip holds the ring as well as the status, so it outlives any one
		// message: "Thinking…" comes and goes, how full the context is does not.
		this.statusEl = root.createDiv({ cls: 'va-status' });
		this.statusTextEl = this.statusEl.createSpan({ cls: 'va-status-text' });
		this.contextRing = new ContextRing(this.statusEl);
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

		// Ctrl/Cmd+S keeps the conversation, the way it keeps a note. It shadows
		// Obsidian's own save only while this panel has focus, where there is no
		// note to save — and stops the event there so nothing else answers it.
		this.registerDomEvent(this.containerEl, 'keydown', (evt) => {
			if (evt.key.toLowerCase() !== 's' || !(evt.ctrlKey || evt.metaKey) || evt.altKey) return;
			evt.preventDefault();
			evt.stopPropagation();
			void this.saveConversation();
		});

		this.mounted = true;
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
		this.prepass?.dispose();
		this.prepass = null;
		this.workflowRun?.stop();
		this.cancelPendingApprovals();
		this.toolEls.clear();
	}

	/** True while a message or workflow run is in flight. */
	isBusy(): boolean {
		return this.busy;
	}

	/**
	 * Re-read everything the header shows about the endpoint. Called when the
	 * endpoint or model changes in settings, which the panel has no other way
	 * to notice.
	 */
	refreshEndpointControls(): void {
		this.refreshModels();
		this.refreshServerFacts();
	}

	/**
	 * Ask the endpoint about the model again: which effort levels it has, and
	 * how much context it has to fill. One request answers for both. The panel
	 * works this out when it opens, so a change of endpoint or model would
	 * otherwise leave it describing the model that was there before.
	 */
	private refreshServerFacts(): void {
		void serverFacts(this.plugin.settings.baseUrl, this.plugin.settings.apiKey).then((facts) => {
			if (!this.mounted) return;
			this.renderEffortOptions(facts.effort);
			this.contextSize = facts.contextSize;
			this.updateContextRing();
		});
	}

	/** Look up the endpoint's models again and redraw the selector. */
	refreshModels(): void {
		void discoverModels(this.plugin.settings.baseUrl, this.plugin.settings.apiKey).then((ids) => {
			if (this.mounted) this.renderModelOptions(filterModels(ids, 'chat'));
		});
	}

	/**
	 * Fill the model selector. The configured name is always offered, even when
	 * the endpoint didn't list it, so a name typed into settings stays selected
	 * instead of being silently swapped for whatever the endpoint listed first.
	 */
	private renderModelOptions(models: string[]): void {
		const current = this.plugin.settings.model;
		this.modelEl.empty();
		if (!models.includes(current)) {
			this.modelEl.createEl('option', {
				value: current,
				text: current ? modelLabel(current) : '(no model set)',
			});
		}
		for (const id of models) this.modelEl.createEl('option', { value: id, text: modelLabel(id) });
		this.modelEl.value = current;
	}

	/**
	 * Switch model. Effort levels belong to the model rather than the endpoint,
	 * so what was worked out for the last one no longer holds.
	 */
	private async applyModel(id: string): Promise<void> {
		this.plugin.settings.model = id;
		await this.plugin.saveSettings();
		clearServerFacts();
		this.refreshServerFacts();
	}

	/**
	 * The levels worth offering for what the endpoint established — narrowed
	 * only as far as it actually told us. A lookup that failed leaves every
	 * level in place; a template that never reads `reasoning_effort` leaves
	 * only `none`, which llama.cpp acts on itself before the template runs, so
	 * it works even where the parameter itself does nothing.
	 */
	private offeredLevels(support: EffortSupport): ReasoningEffort[] {
		switch (support.kind) {
			case 'levels':
				return ['none', ...support.levels];
			case 'ignored':
				return ['none'];
			case 'unenumerated':
				return COMMON_EFFORT_LEVELS;
			case 'unknown':
				return EFFORT_LEVELS;
		}
	}

	/**
	 * Fill the effort selector. The saved choice is always offered, even when
	 * it isn't in the list, so a model swap can't silently change what gets
	 * sent.
	 */
	private renderEffortOptions(support: EffortSupport): void {
		const chosen = this.plugin.settings.reasoningEffort;
		const values: ReasoningEffort[] = ['', ...this.offeredLevels(support)];
		if (chosen && !values.includes(chosen)) values.push(chosen);

		this.effortEl.empty();
		for (const value of values) {
			this.effortEl.createEl('option', { value, text: effortLabel(value) });
		}
		this.effortEl.value = chosen;
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
	private async popOut(): Promise<void> {
		if (this.busy) {
			this.busyNotice();
			return;
		}
		// The saved transcript is what travels: only its path crosses to the new
		// window. An unsaved conversation would simply not arrive, so ask rather
		// than move it and let the user find out.
		if (this.hasUnsavedMessages()) {
			const choice = await askUnsavedChat(this.app, {
				title: 'Save before moving to a new window?',
				body: 'Only a saved conversation can follow the panel — the new window reads it back from the vault. Moving now starts a fresh conversation there and leaves this one behind.',
				saveLabel: 'Save and move',
				discardLabel: 'Move anyway',
			});
			if (choice === 'cancel') return;
			if (choice === 'save' && !(await this.saveNow())) return;
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
		new Notice('Wait for the current response to finish, or stop it with Ctrl+C.');
	}

	private async resetConversation(): Promise<void> {
		if (this.busy) {
			this.busyNotice();
			return;
		}
		if (!(await this.confirmDiscard())) return;
		this.cancelPendingApprovals();
		const systemPrompt = await buildSystemPrompt(this.app, this.plugin.settings);
		this.history = [{ role: 'system', content: systemPrompt }];
		this.conversationPath = null;
		this.persistedCount = 0;
		this.toolEls.clear();
		this.sessionWrites.clear();
		this.sessionMcp.clear();
		// Collected notes belong to the conversation that collected them.
		this.prePassBlock = null;
		// The window is the endpoint's; what fills it belongs to the conversation.
		this.promptTokens = null;
		this.updateContextRing();
		this.updateSaveButton();
		this.messagesEl.empty();
		this.followOutput = true;
		addInfo(
			this.messagesEl,
			'New conversation. The agent can read and (within allowed folders) write your vault.',
		);
	}

	/** Load a saved transcript back into the chat so it can be continued. */
	private async openConversation(file: TFile): Promise<void> {
		if (this.busy) {
			this.busyNotice();
			return;
		}
		if (!(await this.confirmDiscard())) return;
		this.cancelPendingApprovals();
		const systemPrompt = await buildSystemPrompt(this.app, this.plugin.settings);
		const messages = parseConversation(await this.app.vault.cachedRead(file));
		this.history = [{ role: 'system', content: systemPrompt }, ...messages];
		this.conversationPath = file.path;
		this.persistedCount = this.history.length;
		this.toolEls.clear();
		this.sessionWrites.clear();
		this.sessionMcp.clear();
		// Collected notes belong to the conversation that collected them.
		this.prePassBlock = null;
		// The window is the endpoint's; what fills it belongs to the conversation.
		this.promptTokens = null;
		this.updateContextRing();
		this.updateSaveButton();
		this.messagesEl.empty();
		this.followOutput = true;
		addInfo(this.messagesEl, `Continuing "${file.basename}".`);
		for (const m of messages) {
			if (m.role === 'user') addUserBubble(this.messagesEl, m.content);
			else if (m.role === 'assistant') await this.addAssistantBubble(m.content);
		}
		this.scrollToBottom(true);
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
			if (req.kind === 'mcp') {
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
				card.createEl('code', { cls: 'va-approval-path', text: req.path ?? '' });
				// Decide on the actual change, not just the path.
				if (req.preview) preview = addDiffPreview(card, req.preview.before, req.preview.after);
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
				addBtn('Always: this file', 'always-file', 'va-always');
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
		this.statusText = text;
		this.renderStatus();
	}

	private renderStatus(): void {
		// While an answer can still be cut off, say how.
		const stoppable = !!this.abort && !this.abort.signal.aborted;
		const text = this.statusText;
		this.statusTextEl.setText(text ? `${text}${stoppable ? ' · Ctrl+C to stop' : ''}` : '');
		// The strip goes only when it has nothing at all to carry.
		this.statusEl.toggleClass('va-hidden', !text && !this.contextRing.visible);
	}

	/** Redraw the ring from the last counted prompt and the window it fills. */
	private updateContextRing(): void {
		this.contextRing.update(this.promptTokens, this.contextSize);
		this.renderStatus();
	}

	private async addAssistantBubble(markdown: string): Promise<void> {
		await addAssistantBubble(this.app, this, this.messagesEl, markdown);
		this.scrollToBottom();
	}

	private addToolCall(call: ToolCall): void {
		this.toolEls.set(call.id, addToolCall(this.messagesEl, call));
		this.setStatus(`Running ${call.name}…`);
		this.scrollToBottom();
	}

	private addToolResult(call: ToolCall, result: string): void {
		const details = this.toolEls.get(call.id);
		if (!details) return;
		addToolResult(details, result);
		this.setStatus('Thinking…');
		this.scrollToBottom();
	}

	/** Show what a write actually changed, as a diff. */
	private addFileChange(change: FileChange): void {
		const approved = this.approvedWrite;
		if (approved && approved.path === change.path && approved.after === change.after) {
			// This is the write the approval card already previewed.
			markPreviewApplied(approved.card, change);
			this.approvedWrite = null;
			return;
		}
		addFileChange(this.messagesEl, change);
		this.scrollToBottom();
	}

	private addError(message: string): void {
		addError(this.messagesEl, message);
		this.scrollToBottom();
	}

	/** Toggle the chat UI: Send becomes Stop while an answer is in flight. */
	private setBusy(busy: boolean): void {
		this.busy = busy;
		this.sendBtn.disabled = false;
		this.sendBtn.setText(busy ? 'Stop' : 'Send');
		this.sendBtn.toggleClass('va-stop', busy);
		this.sendBtn.onclick = busy ? () => this.interrupt() : () => void this.send();
	}

	/**
	 * Where this conversation's transcript goes. With conversation naming on,
	 * one extra cheap model call turns the opening exchange into a title;
	 * otherwise (and whenever that call is skipped or fails) the first message
	 * is used, as before.
	 */
	private async newConversationPath(firstMessage: string, interrupted: boolean): Promise<string> {
		let label = '';
		// Don't spend a call right after the user hit Stop, or on a turn that
		// produced nothing to name.
		if (this.plugin.settings.nameConversations && !interrupted) {
			const answer = this.lastAssistantContent();
			if (answer) {
				this.setStatus('Naming the conversation…');
				label = await suggestConversationTitle(this.plugin.settings, firstMessage, answer);
			}
		}
		return newConversationPath(this.app, this.plugin.settings, label || firstMessage);
	}

	/** The most recent assistant answer in this conversation, if any. */
	private lastAssistantContent(): string {
		for (let i = this.history.length - 1; i >= 0; i--) {
			const m = this.history[i];
			if (m?.role === 'assistant' && m.content.trim()) return m.content;
		}
		return '';
	}

	private async send(): Promise<void> {
		if (this.busy) return;
		const text = this.inputEl.value.trim();
		if (!text) return;

		this.inputEl.value = '';
		fitToContent(this.inputEl);
		this.history.push({ role: 'user', content: text });
		addUserBubble(this.messagesEl, text);
		this.scrollToBottom(true);

		const abort = new AbortController();
		this.abort = abort;
		this.setBusy(true);
		this.setStatus('Thinking…');

		const system = this.history[0];
		if (system?.role === 'system') {
			// Both blocks are rebuilt from scratch each turn, so stale tabs and
			// last turn's pre-fetched context never pile up. Order matters: the
			// strippers cut from their marker to the end.
			let content = stripOpenFiles(stripPrePass(system.content));
			content += buildOpenFilesBlock(this.app, this.plugin.settings);
			if (this.plugin.settings.usePrePass && !abort.signal.aborted) {
				this.setStatus('Preparing context…');
				// The pre-pass runs on the chat model, so on a reasoning model
				// this is where the wait is. Show its work while it happens.
				const section = new ThinkingSection(this.messagesEl, {
					expanded: this.plugin.settings.expandThinking,
					icon: 'search',
					busyLabel: 'Preparing context…',
					doneLabel: 'Prepared context in',
					onGrow: () => this.scrollToBottom(),
				});
				this.prepass = section;
				this.scrollToBottom(true);
				const block = await prepareContext(
					this.app,
					this.plugin.settings,
					() => this.plugin.saveSettings(),
					this.plugin.mcp,
					this.plugin.rag,
					text,
					{
						// Everything before the message just pushed, so the pass
						// can tell a follow-up from a new subject.
						recent: this.history.slice(1, -1),
						previousHandover: this.prePassBlock ?? undefined,
					},
					{
						// Each round is a separate generation; run them together
						// and the reasoning reads as one long sentence.
						onStep: () => section.pushStepBreak(),
						onReasoning: (delta) => section.push(delta),
						onToolCall: (call) => this.addToolCall(call),
						onToolResult: (call, result) => this.addToolResult(call, result),
						onNote: (note) => section.addNote(note),
					},
					abort.signal,
				);
				section.close();
				// A model that shows no reasoning and a pass that skipped in one
				// call leave an empty section behind; take it back out.
				if (section.isEmpty()) section.remove();
				this.prepass = null;
				// A pass that collected nothing leaves the last one's findings in
				// place rather than answering a follow-up without them.
				if (block) this.prePassBlock = block;
				if (this.prePassBlock) content += this.prePassBlock;
				this.setStatus('Thinking…');
			}
			this.history[0] = { role: 'system', content };
		}

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
				this.history,
				{
					onAssistant: (c) => void this.addAssistantBubble(c),
					onToolCall: (call) => this.addToolCall(call),
					onToolResult: (call, res) => this.addToolResult(call, res),
					onError: (msg) => this.addError(msg),
					onFileChange: (change) => this.addFileChange(change),
					// The prompt the endpoint just counted is what the
					// conversation occupies, so the ring follows the last call.
					onStats: (stats) => {
						if (stats.promptTokens) {
							this.promptTokens = stats.promptTokens;
							this.updateContextRing();
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
							void turn.finish(info);
						},
					},
				},
				{ signal: abort.signal },
			);
		}

		if (abort.signal.aborted && !stopShown) addInfo(this.messagesEl, 'Stopped.');

		// Auto-save decides only whether a conversation gets a file without being
		// asked; once it has one, saving is no longer a decision. Named here,
		// while the panel is still busy, because naming may cost a model call —
		// and from the opening exchange, since the answer says what the
		// conversation turned out to be about better than the question does.
		if (this.plugin.settings.autoSaveConversations && !this.conversationPath) {
			this.conversationPath = await this.newConversationPath(text, abort.signal.aborted);
		}

		this.abort = null;
		this.setStatus(null);
		this.setBusy(false);

		// A conversation that has a file keeps up with the panel: the first save
		// is a decision, the ones after it are not.
		if (this.conversationPath) await this.saveNow();
		this.updateSaveButton();
	}

	/**
	 * Write the conversation to the vault: all of it the first time, only what
	 * is new after that. Returns the path written, or null if nothing was.
	 */
	private async saveNow(interrupted = false): Promise<string | null> {
		if (this.history.length <= 1) return null;
		try {
			if (!this.conversationPath) {
				this.conversationPath = await this.newConversationPath(
					this.firstUserMessage(),
					interrupted,
				);
			}
			if (this.persistedCount > 0) {
				// Append only the new turns, so what is already in the file —
				// including its record of tool calls — is preserved as saved.
				await appendConversation(
					this.app,
					this.conversationPath,
					this.history.slice(this.persistedCount),
				);
			} else {
				await saveConversation(
					this.app,
					this.plugin.settings,
					this.conversationPath,
					this.history,
				);
			}
			this.persistedCount = this.history.length;
			this.updateSaveButton();
			return this.conversationPath;
		} catch (e) {
			new Notice(`Could not save conversation: ${e instanceof Error ? e.message : String(e)}`);
			return null;
		}
	}

	/**
	 * Keep this conversation, and say where it went. Shared by the button, the
	 * Ctrl/Cmd+S shortcut and the command.
	 */
	async saveConversation(): Promise<void> {
		if (this.busy) {
			this.busyNotice();
			return;
		}
		this.setStatus('Saving…');
		const path = await this.saveNow();
		this.setStatus(null);
		if (path) new Notice(`Saved to ${path}`);
	}

	/** Whether the panel is holding anything the vault hasn't got. */
	hasUnsavedMessages(): boolean {
		return this.history.length > Math.max(1, this.persistedCount);
	}

	/**
	 * Ask before throwing an unsaved conversation away. True means carry on —
	 * either it was saved just now, or the user said to drop it.
	 */
	private async confirmDiscard(): Promise<boolean> {
		if (!this.hasUnsavedMessages()) return true;
		const choice = await askUnsavedChat(this.app, {
			title: 'This conversation has not been saved',
			body: 'It only exists in this panel. Save it to the conversations folder, or discard it and carry on.',
			saveLabel: 'Save',
			discardLabel: 'Discard',
		});
		if (choice === 'cancel') return false;
		// A save that failed has already said so; carrying on would throw away
		// what the user just asked to keep.
		if (choice === 'save') return (await this.saveNow()) !== null;
		return true;
	}

	/** The message the file gets named after. */
	private firstUserMessage(): string {
		return this.history.find((m) => m.role === 'user')?.content.trim() || 'Conversation';
	}

	/** Nothing to save, or nothing left to save, is worth showing on the button. */
	private updateSaveButton(): void {
		if (!this.saveBtn) return;
		const unsaved = this.hasUnsavedMessages();
		this.saveBtn.disabled = !unsaved;
		this.saveBtn.setAttr(
			'aria-label',
			unsaved
				? 'Save this conversation'
				: this.conversationPath
					? `Saved to ${this.conversationPath}`
					: 'Nothing to save yet',
		);
	}

	/** Open the workflow modal (also reachable via the "Run workflow" command). */
	openWorkflowModal(preselectId?: string): void {
		if (this.busy) {
			this.busyNotice();
			return;
		}
		new WorkflowModal(
			this.app,
			this.plugin,
			(start) => void this.startWorkflow(start),
			preselectId,
		).open();
	}

	/** Host an autonomous workflow run in this panel until it pauses or finishes. */
	async startWorkflow(start: WorkflowStart): Promise<void> {
		if (this.busy) {
			this.busyNotice();
			return;
		}
		// The run builds its own per-round context; reset the panel so any chat
		// afterwards starts from a clean conversation. The run's transcript is
		// not saved as a conversation — the run note is the artifact.
		await this.resetConversation();
		this.messagesEl.empty();

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
		addInfo(this.messagesEl, `Progress is saved to "${path}".`);

		this.setRunBusy(true);
		this.workflowRun = new WorkflowRun(
			this.app,
			this.plugin.settings,
			() => this.plugin.saveSettings(),
			this.plugin.mcp,
			this.plugin.rag,
			start.workflow,
			{ path, maxRounds: start.maxRounds, delaySeconds: start.delaySeconds },
			{
				onAssistant: (c) => void this.addAssistantBubble(c),
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
			this.setRunBusy(false);
		}
	}

	/** Toggle the run UI: input locked, Send becomes Stop. */
	private setRunBusy(busy: boolean): void {
		this.busy = busy;
		this.inputEl.disabled = busy;
		this.inputEl.placeholder = busy ? 'Workflow run in progress…' : PLACEHOLDER;
		this.setStatus(busy ? 'Workflow run in progress…' : null);
		this.sendBtn.disabled = false;
		this.sendBtn.setText(busy ? 'Stop' : 'Send');
		this.sendBtn.toggleClass('va-stop', busy);
		this.sendBtn.onclick = busy ? () => this.interrupt() : () => void this.send();
	}
}
