import { Notice, Plugin, WorkspaceLeaf } from 'obsidian';
import {
	VaultAssistantSettings,
	VaultAssistantSettingTab,
	DEFAULT_SETTINGS,
	DEFAULT_SYSTEM_PROMPT,
	LEGACY_SYSTEM_PROMPTS,
} from './settings';
import { ChatView, VIEW_TYPE_CHAT } from './ui/chat-view';
import { McpManager } from './mcp/manager';
import { RagIndexer } from './rag/indexer';

export default class VaultAssistantPlugin extends Plugin {
	settings!: VaultAssistantSettings;
	mcp = new McpManager();
	rag!: RagIndexer;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.rag = new RagIndexer(
			this.app,
			() => this.settings,
			this.manifest.dir ?? `.obsidian/plugins/${this.manifest.id}`,
		);

		this.registerView(VIEW_TYPE_CHAT, (leaf: WorkspaceLeaf) => new ChatView(leaf, this));

		this.addRibbonIcon('bot', 'Vault assistant', () => void this.activateView());

		this.addCommand({
			id: 'open-chat',
			name: 'Open chat',
			callback: () => void this.activateView(),
		});

		this.addCommand({
			id: 'reindex-vault',
			name: 'Reindex vault for semantic search',
			callback: () => void this.reindexRag(),
		});

		this.addSettingTab(new VaultAssistantSettingTab(this.app, this));

		// Keep the semantic index fresh as notes change (no-ops while RAG is off).
		this.registerEvent(this.app.vault.on('modify', (f) => this.rag.queue(f.path)));
		this.registerEvent(this.app.vault.on('create', (f) => this.rag.queue(f.path)));
		this.registerEvent(this.app.vault.on('delete', (f) => this.rag.remove(f.path)));
		this.registerEvent(this.app.vault.on('rename', (f, old) => this.rag.rename(f.path, old)));

		// Connect MCP servers in the background; per-server failures are non-fatal.
		void this.mcp.connectAll(this.settings);
	}

	/** Rebuild the semantic index, reporting progress and outcome as notices. */
	async reindexRag(): Promise<void> {
		if (!this.settings.useRag) {
			new Notice('Semantic search is disabled. Enable it in the plugin settings first.');
			return;
		}
		const notice = new Notice('Semantic index: starting…', 0);
		try {
			const res = await this.rag.reindexAll((done, total) =>
				notice.setMessage(`Semantic index: ${done}/${total} files`),
			);
			notice.setMessage(`Semantic index ready: ${res.chunks} chunks from ${res.files} files.`);
			window.setTimeout(() => notice.hide(), 5000);
		} catch (e) {
			notice.hide();
			new Notice(`Semantic indexing failed: ${e instanceof Error ? e.message : String(e)}`);
		}
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
		// A saved prompt that matches an old default was never customised —
		// upgrade it so new tool guidance reaches existing installs.
		if (LEGACY_SYSTEM_PROMPTS.includes(this.settings.systemPrompt)) {
			this.settings.systemPrompt = DEFAULT_SYSTEM_PROMPT;
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
