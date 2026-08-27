import { FuzzySuggestModal, Notice, Plugin, TFile, WorkspaceLeaf, normalizePath } from 'obsidian';
import {
	VaultAssistantSettings,
	VaultAssistantSettingTab,
	DEFAULT_SETTINGS,
	DEFAULT_SYSTEM_PROMPT,
	LEGACY_SYSTEM_PROMPTS,
} from './settings';
import { ChatView, VIEW_TYPE_CHAT } from './ui/chat-view';
import { ImportModal } from './ui/import-modal';
import { McpManager } from './mcp/manager';
import { RagIndexer } from './rag/indexer';
import { WorkflowDef, loadWorkflows } from './workflows/schema';
import { WORKFLOW_PRESETS, presetToNote } from './workflows/presets';
import { WorkflowRun, createRunNote, expandPlaceholders } from './workflows/runner';
import { workflowToCanvas } from './workflows/canvas';

/** Check the schedule this often; the real cadence lives in settings. */
const SCHEDULE_TICK_MS = 15 * 60 * 1000;
/** Rotate to a fresh run note after this many rounds, so notes stay readable. */
const SCHEDULE_ROTATE_ROUNDS = 7;

export default class VaultAssistantPlugin extends Plugin {
	settings!: VaultAssistantSettings;
	mcp = new McpManager();
	rag!: RagIndexer;
	/** The headless scheduled run currently executing, if any. */
	private scheduledRun: WorkflowRun | null = null;

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

		// Ctrl/Cmd+S does this while the chat panel has focus; the command lets
		// you bind your own hotkey and reach it from anywhere. No default key:
		// a plugin claiming one is a conflict waiting to happen.
		this.addCommand({
			id: 'save-conversation',
			name: 'Save the current conversation',
			checkCallback: (checking: boolean) => {
				const view = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT)[0]?.view;
				if (!(view instanceof ChatView) || !view.hasUnsavedMessages()) return false;
				if (!checking) void view.saveConversation();
				return true;
			},
		});

		// Ctrl+C does this while the chat panel has focus; the command lets you
		// bind your own hotkey and reach it from anywhere.
		this.addCommand({
			id: 'stop-response',
			name: 'Stop the current response',
			checkCallback: (checking: boolean) => {
				const view = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT)[0]?.view;
				if (!(view instanceof ChatView) || !view.isBusy()) return false;
				if (!checking) view.interrupt();
				return true;
			},
		});

		this.addCommand({
			id: 'start-research',
			name: 'Run workflow (research, presets…)',
			callback: () => void this.openWorkflow(),
		});

		this.addCommand({
			id: 'create-workflow-preset',
			name: 'Create workflow preset note',
			callback: () => new PresetPicker(this, (def) => void this.createPresetNote(def)).open(),
		});

		this.addCommand({
			id: 'view-workflow-canvas',
			name: 'View workflow as canvas',
			callback: () =>
				new WorkflowPicker(this, (def) => void this.openWorkflowCanvas(def)).open(),
		});

		this.addCommand({
			id: 'reindex-vault',
			name: 'Reindex vault for semantic search',
			callback: () => void this.reindexRag(),
		});

		this.addCommand({
			id: 'import-conversations',
			name: 'Import conversations (Claude Code, claude.ai, ChatGPT)',
			callback: () => new ImportModal(this.app, this).open(),
		});

		this.addSettingTab(new VaultAssistantSettingTab(this.app, this));

		// Keep the semantic index fresh as notes change (no-ops while RAG is off).
		this.registerEvent(this.app.vault.on('modify', (f) => this.rag.queue(f.path)));
		this.registerEvent(this.app.vault.on('create', (f) => this.rag.queue(f.path)));
		this.registerEvent(this.app.vault.on('delete', (f) => this.rag.remove(f.path)));
		this.registerEvent(this.app.vault.on('rename', (f, old) => this.rag.rename(f.path, old)));

		// Connect MCP servers once all plugins have loaded (plugin-transport
		// servers need their target plugin present); failures are non-fatal.
		this.app.workspace.onLayoutReady(() => {
			void this.mcp.connectAll(this.app, this.settings);
			// Catch-up pass shortly after startup, then a steady tick. The real
			// cadence (every N hours) is enforced inside maybeRunScheduled.
			window.setTimeout(() => void this.maybeRunScheduled(), 30_000);
			this.registerInterval(
				window.setInterval(() => void this.maybeRunScheduled(), SCHEDULE_TICK_MS),
			);
		});
	}

	/** Run the scheduled workflow headlessly when its interval has elapsed. */
	private async maybeRunScheduled(): Promise<void> {
		const s = this.settings;
		if (!s.scheduleEnabled || this.scheduledRun) return;
		const intervalMs = Math.max(1, s.scheduleEveryHours) * 3_600_000;
		if (s.lastScheduledRun + intervalMs > Date.now()) return;

		const { workflows } = loadWorkflows(this.app, s, WORKFLOW_PRESETS);
		const workflow = workflows.find((w) => w.id === s.scheduleWorkflowId);
		if (!workflow) {
			console.warn(`[vault-assistant] scheduled workflow "${s.scheduleWorkflowId}" not found.`);
			return;
		}

		// Stamp before running so a failing run waits a full interval to retry
		// instead of hammering the endpoint every tick.
		s.lastScheduledRun = Date.now();
		await this.saveSettings();

		let path: string;
		try {
			path =
				this.findResumableRunNote(workflow.id) ??
				(await createRunNote(
					this.app,
					s,
					workflow,
					expandPlaceholders(s.scheduleGoal, s),
				));
		} catch (e) {
			console.warn('[vault-assistant] scheduled run could not get a run note:', e);
			return;
		}

		new Notice(`Vault assistant: scheduled "${workflow.name}" starting.`);
		this.scheduledRun = new WorkflowRun(
			this.app,
			s,
			() => this.saveSettings(),
			this.mcp,
			this.rag,
			workflow,
			{ path, maxRounds: 1, delaySeconds: 0 },
			{
				onAssistant: () => {},
				onToolCall: () => {},
				onToolResult: () => {},
				onError: (m) => console.warn('[vault-assistant] scheduled run:', m),
				onInfo: (t) => console.debug('[vault-assistant] scheduled run:', t),
			},
		);
		try {
			const outcome = await this.scheduledRun.run();
			this.settings.lastScheduledOutcome = `${new Date().toLocaleString()} — ${workflow.name}: ${outcome}`;
			new Notice(`Vault assistant: "${workflow.name}" ${outcome}. Report: ${path}`);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			this.settings.lastScheduledOutcome = `${new Date().toLocaleString()} — ${workflow.name} failed: ${msg}`;
			console.warn('[vault-assistant] scheduled run failed:', e);
		} finally {
			this.scheduledRun = null;
			await this.saveSettings();
		}
	}

	/**
	 * The freshest unfinished run note for this workflow, unless it has grown
	 * past the rotation cap — then a fresh note is started instead.
	 */
	private findResumableRunNote(workflowId: string): string | null {
		const folder = normalizePath(this.settings.researchFolder);
		const prefix = folder ? `${folder}/` : '';
		const candidate = this.app.vault
			.getMarkdownFiles()
			.filter((f) => f.path.startsWith(prefix))
			.filter((f) => {
				const fm = this.app.metadataCache.getFileCache(f)?.frontmatter ?? {};
				return (
					fm.workflow === workflowId &&
					typeof fm.status === 'string' &&
					fm.status !== 'done' &&
					(Number(fm.rounds) || 0) < SCHEDULE_ROTATE_ROUNDS
				);
			})
			.sort((a, b) => b.stat.mtime - a.stat.mtime)[0];
		return candidate?.path ?? null;
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
		this.scheduledRun?.stop();
		this.mcp.dispose();
	}

	/** Reconnect all MCP servers after a settings change. */
	async reconnectMcp(): Promise<void> {
		await this.mcp.connectAll(this.app, this.settings);
	}

	/** Open the chat panel and the workflow modal. */
	async openWorkflow(preselectId?: string): Promise<void> {
		await this.activateView();
		const view = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT)[0]?.view;
		if (view instanceof ChatView) view.openWorkflowModal(preselectId);
	}

	/**
	 * Write (or refresh) the generated canvas view of a workflow next to the
	 * workflow notes and open it. The canvas is a one-way export — the note's
	 * frontmatter stays the source of truth.
	 */
	async openWorkflowCanvas(def: WorkflowDef): Promise<void> {
		const folder = normalizePath(this.settings.workflowsFolder);
		if (!this.app.vault.getAbstractFileByPath(folder)) {
			await this.app.vault.createFolder(folder).catch(() => undefined);
		}
		const path = normalizePath(`${folder}/${def.id}.canvas`);
		const content = workflowToCanvas(def);
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) await this.app.vault.modify(existing, content);
		else await this.app.vault.create(path, content);

		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) await this.app.workspace.getLeaf(true).openFile(file);
	}

	/** Write a built-in preset into the workflows folder as an editable note. */
	async createPresetNote(def: WorkflowDef): Promise<void> {
		const folder = normalizePath(this.settings.workflowsFolder);
		const path = normalizePath(`${folder}/${def.id}.md`);
		if (this.app.vault.getAbstractFileByPath(path)) {
			new Notice(`Workflow note already exists: ${path}`);
			return;
		}
		if (!this.app.vault.getAbstractFileByPath(folder)) {
			await this.app.vault.createFolder(folder).catch(() => undefined);
		}
		await this.app.vault.create(path, presetToNote(def));
		new Notice(`Created ${path} — edit it to customise the workflow.`);
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

	/**
	 * Have every open chat panel re-read the endpoint: which models it serves,
	 * and which effort levels the chosen one has. A panel works both out when
	 * it opens, so without this a change of endpoint in settings leaves it
	 * describing the one that was there before. Every leaf, not the first: a
	 * popped-out panel is another one.
	 */
	refreshEndpointControls(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT)) {
			if (leaf.view instanceof ChatView) leaf.view.refreshEndpointControls();
		}
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
		// Seed the Life Tracker integration once, disabled, so wiring it up is
		// a single toggle. Seeded exactly once — deleting it is respected.
		if (!this.settings.seededLifeTrackerServer) {
			this.settings.seededLifeTrackerServer = true;
			if (!this.settings.mcpServers.some((s) => s.pluginId === 'obsidian-life-tracker')) {
				this.settings.mcpServers.push({
					id: 'lifetracker',
					name: 'Life Tracker',
					enabled: false,
					trusted: false,
					transport: 'plugin',
					pluginId: 'obsidian-life-tracker',
				});
			}
			await this.saveData(this.settings);
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}

/** Pick any available workflow (presets + vault notes). */
class WorkflowPicker extends FuzzySuggestModal<WorkflowDef> {
	private items: WorkflowDef[];

	constructor(
		plugin: VaultAssistantPlugin,
		private onPick: (def: WorkflowDef) => void,
	) {
		super(plugin.app);
		this.setPlaceholder('Pick a workflow to view as canvas…');
		this.items = loadWorkflows(plugin.app, plugin.settings, WORKFLOW_PRESETS).workflows;
	}

	getItems(): WorkflowDef[] {
		return this.items;
	}

	getItemText(item: WorkflowDef): string {
		return `${item.name}${item.source === 'vault' ? ' (vault)' : ''} — ${item.description}`;
	}

	onChooseItem(item: WorkflowDef): void {
		this.onPick(item);
	}
}

/** Pick a built-in preset to copy into the workflows folder. */
class PresetPicker extends FuzzySuggestModal<WorkflowDef> {
	constructor(
		plugin: VaultAssistantPlugin,
		private onPick: (def: WorkflowDef) => void,
	) {
		super(plugin.app);
		this.setPlaceholder('Copy a workflow preset into your vault…');
	}

	getItems(): WorkflowDef[] {
		return WORKFLOW_PRESETS;
	}

	getItemText(item: WorkflowDef): string {
		return `${item.name} — ${item.description}`;
	}

	onChooseItem(item: WorkflowDef): void {
		this.onPick(item);
	}
}
