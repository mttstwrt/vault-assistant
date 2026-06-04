import { Plugin, WorkspaceLeaf } from 'obsidian';
import { AIChatSettings, AIChatSettingTab, DEFAULT_SETTINGS } from './settings';
import { ChatView, VIEW_TYPE_CHAT } from './ui/chat-view';

export default class AIVaultChatPlugin extends Plugin {
	settings!: AIChatSettings;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.registerView(VIEW_TYPE_CHAT, (leaf: WorkspaceLeaf) => new ChatView(leaf, this));

		this.addRibbonIcon('bot', 'AI vault chat', () => void this.activateView());

		this.addCommand({
			id: 'open-chat',
			name: 'Open chat',
			callback: () => void this.activateView(),
		});

		this.addSettingTab(new AIChatSettingTab(this.app, this));
	}

	async activateView(): Promise<void> {
		const { workspace } = this.app;
		let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE_CHAT)[0] ?? null;
		if (!leaf) {
			leaf = workspace.getRightLeaf(false);
			await leaf?.setViewState({ type: VIEW_TYPE_CHAT, active: true });
		}
		if (leaf) await workspace.revealLeaf(leaf);
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<AIChatSettings>,
		);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
