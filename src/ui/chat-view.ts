import { ItemView, MarkdownRenderer, Notice, WorkspaceLeaf, setIcon } from 'obsidian';
import type VaultAssistantPlugin from '../main';
import { ChatMessage, ToolCall } from '../types';
import { runAgent } from '../agent';
import { buildSystemPrompt } from '../prompts';
import { newConversationPath, saveConversation } from '../conversation';

export const VIEW_TYPE_CHAT = 'vault-assistant-view';

export class ChatView extends ItemView {
	private plugin: VaultAssistantPlugin;
	private history: ChatMessage[] = [];
	private conversationPath: string | null = null;
	private busy = false;

	private messagesEl!: HTMLElement;
	private inputEl!: HTMLTextAreaElement;
	private sendBtn!: HTMLButtonElement;
	private toolEls = new Map<string, HTMLElement>();

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

		this.messagesEl = root.createDiv({ cls: 'va-messages' });

		const inputRow = root.createDiv({ cls: 'va-input-row' });
		this.inputEl = inputRow.createEl('textarea', {
			cls: 'va-input',
			attr: { rows: '2', placeholder: 'Ask about your vault…  (Enter to send, Shift+Enter for newline)' },
		});
		this.sendBtn = inputRow.createEl('button', { cls: 'va-send', text: 'Send' });

		this.sendBtn.onclick = () => void this.send();
		this.inputEl.addEventListener('keydown', (evt) => {
			if (evt.key === 'Enter' && !evt.shiftKey) {
				evt.preventDefault();
				void this.send();
			}
		});

		await this.resetConversation();
	}

	async onClose(): Promise<void> {
		this.toolEls.clear();
	}

	private async resetConversation(): Promise<void> {
		const systemPrompt = await buildSystemPrompt(this.app, this.plugin.settings);
		this.history = [{ role: 'system', content: systemPrompt }];
		this.conversationPath = null;
		this.toolEls.clear();
		this.messagesEl.empty();
		this.addInfo('New conversation. The agent can read and (within allowed folders) write your vault.');
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

	private setBusy(busy: boolean): void {
		this.busy = busy;
		this.sendBtn.disabled = busy;
		this.sendBtn.setText(busy ? 'Thinking…' : 'Send');
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

		this.setBusy(true);
		const thinking = this.messagesEl.createDiv({ cls: 'va-info va-thinking', text: 'Thinking…' });
		this.scrollToBottom();

		await runAgent(this.app, this.plugin.settings, this.history, {
			onAssistant: (c) => void this.addAssistantBubble(c),
			onToolCall: (call) => this.addToolCall(call),
			onToolResult: (call, res) => this.addToolResult(call, res),
			onError: (msg) => this.addError(msg),
		});

		thinking.remove();
		this.setBusy(false);

		if (this.plugin.settings.autoSaveConversations && this.conversationPath) {
			try {
				await saveConversation(
					this.app,
					this.plugin.settings,
					this.conversationPath,
					this.history,
				);
			} catch (e) {
				new Notice(`Could not save conversation: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
	}
}
