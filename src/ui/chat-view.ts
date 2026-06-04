import { ItemView, MarkdownRenderer, Notice, WorkspaceLeaf, setIcon } from 'obsidian';
import type AIVaultChatPlugin from '../main';
import { ChatMessage, ToolCall } from '../types';
import { runAgent } from '../agent';
import { buildSystemPrompt } from '../prompts';
import { newConversationPath, saveConversation } from '../conversation';

export const VIEW_TYPE_CHAT = 'ai-vault-chat-view';

export class ChatView extends ItemView {
	private plugin: AIVaultChatPlugin;
	private history: ChatMessage[] = [];
	private conversationPath: string | null = null;
	private busy = false;

	private messagesEl!: HTMLElement;
	private inputEl!: HTMLTextAreaElement;
	private sendBtn!: HTMLButtonElement;
	private toolEls = new Map<string, HTMLElement>();

	constructor(leaf: WorkspaceLeaf, plugin: AIVaultChatPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_CHAT;
	}

	getDisplayText(): string {
		return 'AI vault chat';
	}

	getIcon(): string {
		return 'bot';
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass('ai-vault-chat');

		const header = root.createDiv({ cls: 'avc-header' });
		header.createEl('span', { text: 'AI vault chat', cls: 'avc-title' });
		const newBtn = header.createEl('button', { cls: 'avc-new', attr: { 'aria-label': 'New chat' } });
		setIcon(newBtn, 'plus');
		newBtn.onclick = () => this.resetConversation();

		this.messagesEl = root.createDiv({ cls: 'avc-messages' });

		const inputRow = root.createDiv({ cls: 'avc-input-row' });
		this.inputEl = inputRow.createEl('textarea', {
			cls: 'avc-input',
			attr: { rows: '2', placeholder: 'Ask about your vault…  (Enter to send, Shift+Enter for newline)' },
		});
		this.sendBtn = inputRow.createEl('button', { cls: 'avc-send', text: 'Send' });

		this.sendBtn.onclick = () => void this.send();
		this.inputEl.addEventListener('keydown', (evt) => {
			if (evt.key === 'Enter' && !evt.shiftKey) {
				evt.preventDefault();
				void this.send();
			}
		});

		this.resetConversation();
	}

	async onClose(): Promise<void> {
		this.toolEls.clear();
	}

	private resetConversation(): void {
		this.history = [{ role: 'system', content: buildSystemPrompt(this.plugin.settings) }];
		this.conversationPath = null;
		this.toolEls.clear();
		this.messagesEl.empty();
		this.addInfo('New conversation. The agent can read and (within allowed folders) write your vault.');
	}

	private scrollToBottom(): void {
		this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
	}

	private addInfo(text: string): void {
		this.messagesEl.createDiv({ cls: 'avc-info', text });
	}

	private addUserBubble(text: string): void {
		const bubble = this.messagesEl.createDiv({ cls: 'avc-msg avc-user' });
		bubble.createDiv({ cls: 'avc-role', text: 'You' });
		bubble.createDiv({ cls: 'avc-content', text });
		this.scrollToBottom();
	}

	private async addAssistantBubble(markdown: string): Promise<void> {
		const bubble = this.messagesEl.createDiv({ cls: 'avc-msg avc-assistant' });
		bubble.createDiv({ cls: 'avc-role', text: 'Assistant' });
		const content = bubble.createDiv({ cls: 'avc-content' });
		await MarkdownRenderer.render(this.app, markdown, content, '', this);
		this.scrollToBottom();
	}

	private addToolCall(call: ToolCall): void {
		const details = this.messagesEl.createEl('details', { cls: 'avc-tool' });
		const summary = details.createEl('summary');
		setIcon(summary.createSpan({ cls: 'avc-tool-icon' }), 'wrench');
		summary.createSpan({ text: ` ${call.name}` });
		details.createEl('pre', { cls: 'avc-tool-args', text: call.arguments });
		this.toolEls.set(call.id, details);
		this.scrollToBottom();
	}

	private addToolResult(call: ToolCall, result: string): void {
		const details = this.toolEls.get(call.id);
		if (!details) return;
		const trimmed = result.length > 2000 ? result.slice(0, 2000) + '\n…(truncated)' : result;
		details.createEl('pre', { cls: 'avc-tool-result', text: trimmed });
		this.scrollToBottom();
	}

	private addError(message: string): void {
		this.messagesEl.createDiv({ cls: 'avc-error', text: `⚠️ ${message}` });
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
		const thinking = this.messagesEl.createDiv({ cls: 'avc-info avc-thinking', text: 'Thinking…' });
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
