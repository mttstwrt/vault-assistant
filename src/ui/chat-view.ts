import { ItemView, Keymap, Notice, TFile, WorkspaceLeaf, setIcon } from 'obsidian';
import type VaultAssistantPlugin from '../main';
import { ApprovalRequest, ApprovalResult, ChatMessage, ToolCall } from '../types';
import { runAgent } from '../agent';
import { buildSystemPrompt } from '../prompts';
import {
	appendConversation,
	newConversationPath,
	parseConversation,
	saveConversation,
} from '../conversation';
import { ConversationPicker } from './conversation-modal';
import { ImportModal } from './import-modal';
import { WorkflowModal, WorkflowStart } from './workflow-modal';
import { WorkflowRun, createRunNote } from '../workflows/runner';
import { prepareContext, stripPrePass } from '../prepass';
import { suggestConversationTitle } from '../title';
import { buildOpenFilesBlock, stripOpenFiles } from '../tools/workspace';
import { AssistantTurn } from './assistant-turn';
import { fitToContent } from './autogrow';
import {
	addAssistantBubble,
	addError,
	addInfo,
	addToolCall,
	addToolResult,
	addUserBubble,
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
	private inputEl!: HTMLTextAreaElement;
	private sendBtn!: HTMLButtonElement;
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

		const importBtn = header.createEl('button', {
			cls: 'va-new',
			attr: { 'aria-label': 'Import conversations' },
		});
		setIcon(importBtn, 'import');
		importBtn.onclick = () => new ImportModal(this.app, this.plugin).open();

		const workflowBtn = header.createEl('button', {
			cls: 'va-new',
			attr: { 'aria-label': 'Run workflow' },
		});
		setIcon(workflowBtn, 'telescope');
		workflowBtn.onclick = () => this.openWorkflowModal();

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

		await this.resetConversation();
	}

	async onClose(): Promise<void> {
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
		this.cancelPendingApprovals();
		const systemPrompt = await buildSystemPrompt(this.app, this.plugin.settings);
		this.history = [{ role: 'system', content: systemPrompt }];
		this.conversationPath = null;
		this.persistedCount = 0;
		this.toolEls.clear();
		this.sessionWrites.clear();
		this.sessionMcp.clear();
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
		this.cancelPendingApprovals();
		const systemPrompt = await buildSystemPrompt(this.app, this.plugin.settings);
		const messages = parseConversation(await this.app.vault.cachedRead(file));
		this.history = [{ role: 'system', content: systemPrompt }, ...messages];
		this.conversationPath = file.path;
		this.persistedCount = this.history.length;
		this.toolEls.clear();
		this.sessionWrites.clear();
		this.sessionMcp.clear();
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
	}

	/** Render an approval card and resolve when the user picks an option. */
	private requestApproval(req: ApprovalRequest): Promise<ApprovalResult> {
		return new Promise<ApprovalResult>((resolve) => {
			this.pendingApprovals.add(resolve);

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
			}

			const row = card.createDiv({ cls: 'va-approval-actions' });
			const settle = (result: ApprovalResult, label: string): void => {
				if (!this.pendingApprovals.has(resolve)) return;
				this.pendingApprovals.delete(resolve);
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
		// While an answer can still be cut off, say how.
		const stoppable = !!this.abort && !this.abort.signal.aborted;
		this.statusEl.setText(text ? `${text}${stoppable ? ' · Ctrl+C to stop' : ''}` : '');
		this.statusEl.toggleClass('va-hidden', !text);
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
				const block = await prepareContext(this.app, this.plugin.settings, this.plugin.rag, text);
				if (block) content += block;
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

		// Name the file once, from the opening exchange — the answer says what
		// the conversation turned out to be about better than the question does.
		if (this.plugin.settings.autoSaveConversations && !this.conversationPath) {
			this.conversationPath = await this.newConversationPath(text, abort.signal.aborted);
		}

		this.abort = null;
		this.setStatus(null);
		this.setBusy(false);

		if (this.plugin.settings.autoSaveConversations && this.conversationPath) {
			try {
				if (this.persistedCount > 0) {
					// Reopened conversation: append only the new turns, so the
					// original file is preserved as saved.
					await appendConversation(
						this.app,
						this.conversationPath,
						this.history.slice(this.persistedCount),
					);
					this.persistedCount = this.history.length;
				} else {
					await saveConversation(
						this.app,
						this.plugin.settings,
						this.conversationPath,
						this.history,
					);
				}
			} catch (e) {
				new Notice(`Could not save conversation: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
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
