import { App, Modal, Notice, Platform, Setting, moment } from 'obsidian';
import type VaultAssistantPlugin from '../main';
import {
	ClaudeSession,
	defaultProjectsDir,
	importSession,
	listSessions,
} from '../import/claude-code';

/** Pick and import Claude Code sessions as conversation notes. */
export class ImportModal extends Modal {
	private plugin: VaultAssistantPlugin;
	private sessions: ClaudeSession[] = [];
	private selected = new Set<ClaudeSession>();
	private listEl!: HTMLElement;
	private statusEl!: HTMLElement;
	private importBtn!: HTMLButtonElement;

	constructor(app: App, plugin: VaultAssistantPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen(): void {
		const { contentEl } = this;
		this.titleEl.setText('Import Claude Code conversations');

		if (!Platform.isDesktopApp) {
			contentEl.setText('Importing reads local files, so it is only available on desktop.');
			return;
		}

		contentEl.createEl('p', {
			cls: 'va-import-desc',
			text:
				'Scans Claude Code session logs and saves them as clean transcripts under ' +
				`"${this.plugin.settings.conversationsFolder}/Claude Code/". Your messages and the ` +
				'assistant’s thinking and answers are kept; tool calls and results are dropped. ' +
				'Already-imported sessions are skipped.',
		});

		let dir = defaultProjectsDir();
		new Setting(contentEl)
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
					.onClick(() => this.scan(dir)),
			);

		this.statusEl = contentEl.createDiv({ cls: 'va-import-status' });
		this.listEl = contentEl.createDiv({ cls: 'va-import-list' });

		const actions = new Setting(contentEl);
		actions.addButton((b) => {
			this.importBtn = b.buttonEl;
			b.setButtonText('Import selected')
				.setCta()
				.setDisabled(true)
				.onClick(() => void this.runImport());
		});
	}

	private scan(dir: string): void {
		this.listEl.empty();
		this.selected.clear();
		this.importBtn.disabled = true;
		try {
			this.sessions = listSessions(dir);
		} catch (e) {
			this.statusEl.setText(`Could not scan: ${e instanceof Error ? e.message : String(e)}`);
			return;
		}
		if (!this.sessions.length) {
			this.statusEl.setText('No importable sessions found.');
			return;
		}
		this.statusEl.setText(`${this.sessions.length} sessions found.`);
		this.renderList();
	}

	private renderList(): void {
		const rows: { box: HTMLInputElement; session: ClaudeSession }[] = [];

		const allRow = this.listEl.createDiv({ cls: 'va-import-row va-import-all' });
		const allBox = allRow.createEl('input', { type: 'checkbox' });
		allRow.createEl('label', { text: 'Select all' });
		allBox.onchange = () => {
			this.selected.clear();
			for (const { box, session } of rows) {
				box.checked = allBox.checked;
				if (allBox.checked) this.selected.add(session);
			}
			this.importBtn.disabled = this.selected.size === 0;
		};

		for (const session of this.sessions) {
			const row = this.listEl.createDiv({ cls: 'va-import-row' });
			const box = row.createEl('input', { type: 'checkbox' });
			rows.push({ box, session });
			box.onchange = () => {
				if (box.checked) this.selected.add(session);
				else this.selected.delete(session);
				this.importBtn.disabled = this.selected.size === 0;
			};
			const label = row.createDiv({ cls: 'va-import-label' });
			label.createDiv({ text: session.title });
			label.createDiv({
				cls: 'va-import-meta',
				text: `${session.project} · ${moment(session.mtime).format('YYYY-MM-DD HH:mm')}`,
			});
		}
	}

	private async runImport(): Promise<void> {
		this.importBtn.disabled = true;
		const picked = this.sessions.filter((s) => this.selected.has(s));
		let imported = 0;
		let skipped = 0;
		for (const [i, session] of picked.entries()) {
			this.statusEl.setText(`Importing… ${i + 1}/${picked.length}`);
			try {
				const outcome = await importSession(this.app, this.plugin.settings, session);
				if (outcome === 'imported') imported++;
				else skipped++;
			} catch (e) {
				new Notice(
					`Import failed for "${session.title}": ${e instanceof Error ? e.message : String(e)}`,
				);
			}
		}
		const summary = `Imported ${imported} conversation${imported === 1 ? '' : 's'}${
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
