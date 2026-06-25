import { Plugin, WorkspaceLeaf } from 'obsidian';
import { VaultAssistantSettings, VaultAssistantSettingTab, DEFAULT_SETTINGS } from './settings';
import { ChatView, VIEW_TYPE_CHAT } from './ui/chat-view';
import { McpManager } from './mcp/manager';

export default class VaultAssistantPlugin extends Plugin {
	settings!: VaultAssistantSettings;
	mcp = new McpManager();

	async onload(): Promise<void> {
		await this.loadSettings();

		this.registerView(VIEW_TYPE_CHAT, (leaf: WorkspaceLeaf) => new ChatView(leaf, this));

		this.addRibbonIcon('bot', 'Vault assistant', () => void this.activateView());

		this.addCommand({
			id: 'open-chat',
			name: 'Open chat',
			callback: () => void this.activateView(),
		});

		this.addSettingTab(new VaultAssistantSettingTab(this.app, this));

		// Connect MCP servers in the background; per-server failures are non-fatal.
		void this.mcp.connectAll(this.settings);
	}

	onunload(): void {
		this.mcp.dispose();
	}

	/** Reconnect all MCP servers after a settings change. */
	async reconnectMcp(): Promise<void> {
		await this.mcp.connectAll(this.settings);
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
			(await this.loadData()) as Partial<VaultAssistantSettings>,
		);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
