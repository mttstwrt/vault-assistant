import { ItemView, Keymap, MarkdownRenderer, Notice, TFile, WorkspaceLeaf, setIcon } from 'obsidian';
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
import { buildOpenFilesBlock, stripOpenFiles } from '../tools/workspace';

export const VIEW_TYPE_CHAT = 'vault-assistant-view';

const INPUT_PLACEHOLDER = 'Ask about your vault…  (Enter to send, Shift+Enter for newline)';

/** Pretty-print a JSON string for display, falling back to the raw text. */
function prettyJson(raw: string): string {
	try {
		return JSON.stringify(JSON.parse(raw), null, 2);
	} catch {
		return raw;
	}
}

export class ChatView extends ItemView {
	private plugin: VaultAssistantPlugin;
	private history: ChatMessage[] = [];
	private conversationPath: string | null = null;
	/** How many history entries are already saved in a reopened conversation's file. */
	private persistedCount = 0;
	private busy = false;

	private messagesEl!: HTMLElement;
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
	/** Aborts the chat turn in flight; set only while one is running. */
	private stopper: AbortController | null = null;

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
		this.messagesEl.addEventListener('click', (evt) => {
			const link = (evt.target as HTMLElement).closest('a.internal-link');
			if (!(link instanceof HTMLElement)) return;
			evt.preventDefault();
			const target = link.getAttr('data-href') ?? link.getAttr('href');
			if (target) void this.app.workspace.openLinkText(target, '', Keymap.isModEvent(evt));
		});
		this.messagesEl.addEventListener('mouseover', (evt) => {
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

		const inputRow = root.createDiv({ cls: 'va-input-row' });
		this.inputEl = inputRow.createEl('textarea', {
			cls: 'va-input',
			attr: { rows: '2', placeholder: INPUT_PLACEHOLDER },
		});
		this.sendBtn = inputRow.createEl('button', { cls: 'va-send', text: 'Send' });

		this.setBusy(false);
		this.inputEl.addEventListener('keydown', (evt) => {
			if (evt.key === 'Enter' && !evt.shiftKey) {
				evt.preventDefault();
				void this.send();
			}
		});

		await this.resetConversation();
	}

	async onClose(): Promise<void> {
		this.stopper?.abort();
		this.workflowRun?.stop();
		this.cancelPendingApprovals();
		this.toolEls.clear();
	}

	/** Whether a response or workflow run is currently in flight. */
	isBusy(): boolean {
		return this.busy;
	}

	/**
	 * Interrupt whatever this panel is running — a chat turn or a workflow run.
	 * The model call in flight is dropped and the loop unwinds at its next
	 * boundary; work already done (tool results, saved notes) is kept.
	 */
	stopResponse(): void {
		if (!this.busy) return;
		this.stopper?.abort();
		this.workflowRun?.stop();
		// An approval card still awaiting a click would hold the turn open.
		this.cancelPendingApprovals();
		this.sendBtn.disabled = true;
		this.sendBtn.setText('Stopping…');
	}

	private async resetConversation(): Promise<void> {
		if (this.busy) {
			new Notice('Stop the current response first.');
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
		this.addInfo('New conversation. The agent can read and (within allowed folders) write your vault.');
	}

	/** Load a saved transcript back into the chat so it can be continued. */
	private async openConversation(file: TFile): Promise<void> {
		if (this.busy) {
			new Notice('Stop the current response first.');
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
		this.addInfo(`Continuing "${file.basename}".`);
		for (const m of messages) {
			if (m.role === 'user') this.addUserBubble(m.content);
			else if (m.role === 'assistant') await this.addAssistantBubble(m.content);
		}
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

			this.scrollToBottom();
		});
	}

	private scrollToBottom(): void {
		this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
	}

	private addInfo(text: string): void {
		this.messagesEl.createDiv({ cls: 'va-info', text });
	}

	private addUserBubble(text: string): void {
		const bubble = this.messagesEl.createDiv({ cls: 'va-msg va-user' });
		bubble.createDiv({ cls: 'va-role', text: 'You' });
		bubble.createDiv({ cls: 'va-content', text });
		this.scrollToBottom();
	}

	private async addAssistantBubble(markdown: string): Promise<void> {
		const bubble = this.messagesEl.createDiv({ cls: 'va-msg va-assistant' });
		bubble.createDiv({ cls: 'va-role', text: 'Assistant' });
		const content = bubble.createDiv({ cls: 'va-content' });
		await MarkdownRenderer.render(this.app, markdown, content, '', this);
		this.scrollToBottom();
	}

	private addToolCall(call: ToolCall): void {
		const details = this.messagesEl.createEl('details', { cls: 'va-tool' });
		const summary = details.createEl('summary');
		setIcon(summary.createSpan({ cls: 'va-tool-icon' }), 'wrench');
		summary.createSpan({ text: ` ${call.name}` });
		details.createEl('pre', { cls: 'va-tool-args', text: call.arguments });
		this.toolEls.set(call.id, details);
		this.scrollToBottom();
	}

	private addToolResult(call: ToolCall, result: string): void {
		const details = this.toolEls.get(call.id);
		if (!details) return;
		const trimmed = result.length > 2000 ? result.slice(0, 2000) + '\n…(truncated)' : result;
		details.createEl('pre', { cls: 'va-tool-result', text: trimmed });
		this.scrollToBottom();
	}

	private addError(message: string): void {
		this.messagesEl.createDiv({ cls: 'va-error', text: `⚠️ ${message}` });
		this.scrollToBottom();
	}

	/** Send doubles as Stop while anything is running, so a turn is never a wait. */
	private setBusy(busy: boolean): void {
		this.busy = busy;
		this.sendBtn.disabled = false;
		this.sendBtn.setText(busy ? 'Stop' : 'Send');
		this.sendBtn.toggleClass('va-stop', busy);
		this.sendBtn.setAttr('aria-label', busy ? 'Stop the response' : 'Send message');
		this.sendBtn.onclick = busy ? () => this.stopResponse() : () => void this.send();
	}

	private async send(): Promise<void> {
		if (this.busy) return;
		const text = this.inputEl.value.trim();
		if (!text) return;

		this.inputEl.value = '';
		this.history.push({ role: 'user', content: text });
		this.addUserBubble(text);

		if (!this.conversationPath) {
			this.conversationPath = newConversationPath(this.plugin.settings, text);
		}

		const stopper = new AbortController();
		this.stopper = stopper;
		this.setBusy(true);
		const thinking = this.messagesEl.createDiv({ cls: 'va-info va-thinking', text: 'Thinking…' });
		this.scrollToBottom();

		try {
			const system = this.history[0];
			if (system?.role === 'system') {
				// Both blocks are rebuilt from scratch each turn, so stale tabs and
				// last turn's pre-fetched context never pile up. Order matters: the
				// strippers cut from their marker to the end.
				let content = stripOpenFiles(stripPrePass(system.content));
				content += buildOpenFilesBlock(this.app, this.plugin.settings);
				if (this.plugin.settings.usePrePass) {
					thinking.setText('Preparing context…');
					const block = await prepareContext(
						this.app,
						this.plugin.settings,
						this.plugin.rag,
						text,
						stopper.signal,
					);
					if (block) content += block;
					thinking.setText('Thinking…');
				}
				this.history[0] = { role: 'system', content };
			}

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
				},
				{ signal: stopper.signal },
			);
		} finally {
			thinking.remove();
			this.stopper = null;
			this.setBusy(false);
		}

		if (stopper.signal.aborted) this.addInfo('Response stopped.');

		// The turn is saved either way: a stopped response still has whatever the
		// agent said and did before the stop, and that belongs in the transcript.
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
			new Notice('Stop the current response first.');
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
			new Notice('Stop the current response first.');
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
		this.addInfo(
			start.file
				? `Resuming "${start.file.basename}" with ${start.workflow.name} (${budget}).`
				: `${start.workflow.name} (${budget}): ${start.goal}`,
		);
		this.addInfo(`Progress is saved to "${path}".`);

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
					this.addInfo(text);
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

	/** Toggle the run UI: input locked on top of the usual Send/Stop swap. */
	private setRunBusy(busy: boolean): void {
		this.inputEl.disabled = busy;
		this.inputEl.placeholder = busy ? 'Workflow run in progress…' : INPUT_PLACEHOLDER;
		this.setBusy(busy);
	}
}
