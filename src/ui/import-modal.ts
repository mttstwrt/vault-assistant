import { App, Modal, Notice, Platform, Setting, moment } from 'obsidian';
import type VaultAssistantPlugin from '../main';
import { ImportOutcome, ImportedConversation, writeConversation } from '../import/common';
import {
	defaultProjectsDir,
	importSession,
	listSessions,
	scanPromptHistory,
	writePromptHistory,
} from '../import/claude-code';
import { parseClaudeWebExport } from '../import/claude-web';
import { parseChatGptExport } from '../import/chatgpt';

type Source = 'claude-code' | 'claude-web' | 'chatgpt';

/** One selectable row in the import list, whatever its source. */
interface ImportItem {
	label: string;
	sublabel: string;
	run: () => Promise<ImportOutcome>;
}

/** Import conversations from AI-service exports as notes in the vault. */
export class ImportModal extends Modal {
	private plugin: VaultAssistantPlugin;
	private source: Source;
	private items: ImportItem[] = [];
	private selected = new Set<ImportItem>();
	private sourceEl!: HTMLElement;
	private listEl!: HTMLElement;
	private statusEl!: HTMLElement;
	private importBtn!: HTMLButtonElement;

	constructor(app: App, plugin: VaultAssistantPlugin) {
		super(app);
		this.plugin = plugin;
		this.source = Platform.isDesktopApp ? 'claude-code' : 'claude-web';
	}

	onOpen(): void {
		const { contentEl } = this;
		this.titleEl.setText('Import conversations');

		contentEl.createEl('p', {
			cls: 'va-import-desc',
			text:
				'Bring past AI conversations into your vault as clean transcripts under ' +
				`"${this.plugin.settings.conversationsFolder}/". Messages, thinking, and answers are ` +
				'kept; tool calls and other noise are dropped. Everything is processed locally, and ' +
				'already-imported conversations are skipped.',
		});

		new Setting(contentEl).setName('Source').addDropdown((d) => {
			if (Platform.isDesktopApp) d.addOption('claude-code', 'Claude Code (local sessions)');
			d.addOption('claude-web', 'Claude (claude.ai export)');
			d.addOption('chatgpt', 'ChatGPT (export)');
			d.setValue(this.source).onChange((v) => {
				this.source = v as Source;
				this.renderSourceControls();
			});
		});

		this.sourceEl = contentEl.createDiv();
		this.statusEl = contentEl.createDiv({ cls: 'va-import-status' });
		this.listEl = contentEl.createDiv({ cls: 'va-import-list' });

		new Setting(contentEl).addButton((b) => {
			this.importBtn = b.buttonEl;
			b.setButtonText('Import selected')
				.setCta()
				.setDisabled(true)
				.onClick(() => void this.runImport());
		});

		this.renderSourceControls();
	}

	/** Swap in the chosen source's controls and clear any previous results. */
	private renderSourceControls(): void {
		this.sourceEl.empty();
		this.setItems([]);
		this.statusEl.setText('');

		if (this.source === 'claude-code') {
			let dir = defaultProjectsDir();
			new Setting(this.sourceEl)
				.setName('Projects folder')
				.setDesc('The Claude Code data directory to scan.')
				.addText((t) =>
					t.setValue(dir).onChange((v) => {
						dir = v.trim();
					}),
				)
				.addButton((b) =>
					b
						.setButtonText('Scan')
						.setCta()
						.onClick(() => this.scanClaudeCode(dir)),
				);
			return;
		}

		const service = this.source === 'claude-web' ? 'claude.ai' : 'ChatGPT';
		const where =
			this.source === 'claude-web'
				? 'claude.ai → Settings → Privacy → Export data'
				: 'chatgpt.com → Settings → Data controls → Export data';
		new Setting(this.sourceEl)
			.setName('Export file')
			.setDesc(`Request your ${service} export (${where}), unzip it, and choose conversations.json.`)
			.addButton((b) => {
				b.setButtonText('Choose file').setCta();
				const input = this.sourceEl.createEl('input', {
					type: 'file',
					attr: { accept: '.json', hidden: true },
				});
				input.onchange = () => {
					const file = input.files?.[0];
					if (file) void this.loadExportFile(file);
					input.value = '';
				};
				b.onClick(() => input.click());
			});
	}

	private scanClaudeCode(dir: string): void {
		let items: ImportItem[];
		try {
			const sessions = listSessions(dir);
			items = sessions.map((s) => ({
				label: s.title,
				sublabel: `${s.project} · ${moment(s.mtime).format('YYYY-MM-DD HH:mm')}`,
				run: () => importSession(this.app, this.plugin.settings, s),
			}));
			const history = scanPromptHistory(dir);
			if (history.orphaned.length) {
				items.unshift({
					label: 'Prompt history (rescued prompts)',
					sublabel: `${history.orphaned.length} of ${history.total} prompts are from sessions no longer on disk`,
					run: () => writePromptHistory(this.app, this.plugin.settings, history.orphaned),
				});
			}
		} catch (e) {
			this.statusEl.setText(`Could not scan: ${e instanceof Error ? e.message : String(e)}`);
			return;
		}
		this.statusEl.setText(items.length ? `${items.length} items found.` : 'No importable sessions found.');
		this.setItems(items);
	}

	private async loadExportFile(file: File): Promise<void> {
		this.statusEl.setText('Reading export…');
		let conversations: ImportedConversation[];
		try {
			const text = await file.text();
			conversations =
				this.source === 'claude-web' ? parseClaudeWebExport(text) : parseChatGptExport(text);
		} catch (e) {
			this.statusEl.setText(`Could not read export: ${e instanceof Error ? e.message : String(e)}`);
			this.setItems([]);
			return;
		}
		conversations.sort((a, b) => moment(b.created ?? 0).valueOf() - moment(a.created ?? 0).valueOf());
		this.statusEl.setText(`${conversations.length} conversations found.`);
		this.setItems(
			conversations.map((c) => ({
				label: c.title.split('\n')[0]?.slice(0, 120) ?? '',
				sublabel: `${c.created ? moment(c.created).format('YYYY-MM-DD') : 'undated'} · ${c.messages.length} messages`,
				run: () => writeConversation(this.app, this.plugin.settings, c),
			})),
		);
	}

	private setItems(items: ImportItem[]): void {
		this.items = items;
		this.selected.clear();
		this.listEl.empty();
		this.importBtn.disabled = true;
		if (!items.length) return;

		const rows: { box: HTMLInputElement; item: ImportItem }[] = [];

		const allRow = this.listEl.createDiv({ cls: 'va-import-row va-import-all' });
		const allBox = allRow.createEl('input', { type: 'checkbox' });
		allRow.createEl('label', { text: 'Select all' });
		allBox.onchange = () => {
			this.selected.clear();
			for (const { box, item } of rows) {
				box.checked = allBox.checked;
				if (allBox.checked) this.selected.add(item);
			}
			this.importBtn.disabled = this.selected.size === 0;
		};

		for (const item of items) {
			const row = this.listEl.createDiv({ cls: 'va-import-row' });
			const box = row.createEl('input', { type: 'checkbox' });
			rows.push({ box, item });
			box.onchange = () => {
				if (box.checked) this.selected.add(item);
				else this.selected.delete(item);
				this.importBtn.disabled = this.selected.size === 0;
			};
			const label = row.createDiv({ cls: 'va-import-label' });
			label.createDiv({ text: item.label });
			label.createDiv({ cls: 'va-import-meta', text: item.sublabel });
		}
	}

	private async runImport(): Promise<void> {
		this.importBtn.disabled = true;
		const picked = this.items.filter((i) => this.selected.has(i));
		let imported = 0;
		let skipped = 0;
		for (const [i, item] of picked.entries()) {
			this.statusEl.setText(`Importing… ${i + 1}/${picked.length}`);
			try {
				const outcome = await item.run();
				if (outcome === 'imported') imported++;
				else skipped++;
			} catch (e) {
				new Notice(`Import failed for "${item.label}": ${e instanceof Error ? e.message : String(e)}`);
			}
		}
		const summary = `Imported ${imported} item${imported === 1 ? '' : 's'}${
			skipped ? `, skipped ${skipped} (already imported or empty)` : ''
		}.`;
		this.statusEl.setText(summary);
		new Notice(summary);
		this.importBtn.disabled = this.selected.size === 0;
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
