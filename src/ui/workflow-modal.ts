import { App, Modal, Notice, Setting, TFile, normalizePath } from 'obsidian';
import type VaultAssistantPlugin from '../main';
import { WorkflowDef, loadWorkflows, workflowForNote } from '../workflows/schema';
import { WORKFLOW_PRESETS } from '../workflows/presets';
import { expandPlaceholders } from '../workflows/runner';

export interface WorkflowStart {
	workflow: WorkflowDef;
	/** Existing run note to resume, or null to start fresh with `goal`. */
	file: TFile | null;
	goal: string;
	/** Rounds to run in this invocation; 0 = until stopped. */
	maxRounds: number;
	delaySeconds: number;
}

/** Pick a workflow and a goal (or an unfinished run to resume) and its budget. */
export class WorkflowModal extends Modal {
	private plugin: VaultAssistantPlugin;
	private onStart: (start: WorkflowStart) => void;
	private workflows: WorkflowDef[] = [];
	private selected!: WorkflowDef;
	private goal = '';
	/** True while the goal box holds user-typed text (don't overwrite it). */
	private goalEdited = false;
	private maxRounds: number;
	private delaySeconds: number;
	private descEl: HTMLElement | null = null;
	private stepsEl: HTMLElement | null = null;
	private goalInput: HTMLTextAreaElement | null = null;
	private roundsInput: HTMLInputElement | null = null;

	constructor(
		app: App,
		plugin: VaultAssistantPlugin,
		onStart: (start: WorkflowStart) => void,
		private preselectId?: string,
	) {
		super(app);
		this.plugin = plugin;
		this.onStart = onStart;
		this.maxRounds = plugin.settings.researchDefaultRounds;
		this.delaySeconds = plugin.settings.researchDefaultDelaySeconds;
	}

	onOpen(): void {
		const { contentEl } = this;
		this.titleEl.setText('Run workflow');

		const { workflows, warnings } = loadWorkflows(this.app, this.plugin.settings, WORKFLOW_PRESETS);
		this.workflows = workflows;
		for (const w of warnings) new Notice(`Workflow skipped: ${w}`);
		const initial =
			workflows.find((w) => w.id === (this.preselectId ?? 'deep-research')) ?? workflows[0];
		if (!initial) {
			contentEl.createEl('p', { text: 'No workflows available.' });
			return;
		}
		this.selected = initial;

		contentEl.createEl('p', {
			cls: 'va-import-desc',
			text:
				'Give the agent a goal to pursue on its own. Progress accumulates in a run note under ' +
				`"${this.plugin.settings.researchFolder}/" and durable insights go to the wiki. ` +
				'You can stop a run at any time and resume it later. Workflow notes in ' +
				`"${this.plugin.settings.workflowsFolder}/" appear here alongside the built-in presets.`,
		});

		new Setting(contentEl)
			.setName('Workflow')
			.addDropdown((d) => {
				for (const w of this.workflows) {
					d.addOption(w.id, w.source === 'vault' ? `${w.name} (vault)` : w.name);
				}
				d.setValue(this.selected.id).onChange((id) => {
					const w = this.workflows.find((x) => x.id === id);
					if (w) {
						this.selected = w;
						this.applyWorkflowDefaults();
					}
				});
			})
			.addExtraButton((b) =>
				b
					.setIcon('workflow')
					.setTooltip('Open as canvas')
					.onClick(() => {
						this.close();
						void this.plugin.openWorkflowCanvas(this.selected);
					}),
			);

		this.descEl = contentEl.createEl('p', { cls: 'va-import-desc' });
		this.stepsEl = contentEl.createDiv({ cls: 'va-wf-steps' });

		new Setting(contentEl).setName('Goal').addTextArea((t) => {
			this.goalInput = t.inputEl;
			t.inputEl.rows = 4;
			t.inputEl.addClass('va-wide-textarea');
			t.setPlaceholder(
				'e.g. Search the vault for ideas I may have forgotten, add insight to the wiki, and suggest next steps…',
			).onChange((v) => {
				this.goal = v;
				// An emptied box counts as untouched, so switching workflows
				// pre-fills their default goal again.
				this.goalEdited = v.trim().length > 0;
			});
		});

		new Setting(contentEl)
			.setName('Rounds')
			.setDesc('How many rounds to run before pausing. 0 = run until stopped.')
			.addText((t) => {
				this.roundsInput = t.inputEl;
				t.setValue(String(this.maxRounds)).onChange((v) => {
					const n = parseInt(v, 10);
					if (!Number.isNaN(n) && n >= 0) this.maxRounds = n;
				});
			});

		new Setting(contentEl)
			.setName('Delay between rounds')
			.setDesc('Seconds to pause between rounds.')
			.addText((t) =>
				t.setValue(String(this.delaySeconds)).onChange((v) => {
					const n = parseInt(v, 10);
					if (!Number.isNaN(n) && n >= 0) this.delaySeconds = n;
				}),
			);

		new Setting(contentEl).addButton((b) =>
			b
				.setButtonText('Start')
				.setCta()
				.onClick(() => {
					const goal = this.goal.trim();
					if (!goal) {
						// Never swallow the click silently (see the import-button fix).
						new Notice('Give the run a goal first.');
						this.goalInput?.focus();
						return;
					}
					this.close();
					this.onStart({
						workflow: this.selected,
						file: null,
						goal,
						maxRounds: this.maxRounds,
						delaySeconds: this.delaySeconds,
					});
				}),
		);

		this.applyWorkflowDefaults();
		this.renderResumeList(contentEl);
	}

	/** Refresh the description, step preview, goal, and rounds for the selection. */
	private applyWorkflowDefaults(): void {
		if (this.descEl) {
			this.descEl.setText(
				this.selected.description +
					(this.selected.loop ? '' : ' Runs a single pass regardless of the rounds budget.'),
			);
		}
		this.renderStepPreview();

		// Self-describing workflows carry a default goal; pre-fill it so Start
		// works immediately, but never overwrite something the user typed.
		if (!this.goalEdited && this.goalInput) {
			const defaultGoal = expandPlaceholders(
				this.selected.defaultGoal ?? '',
				this.plugin.settings,
			);
			this.goalInput.value = defaultGoal;
			this.goal = defaultGoal;
		}

		const rounds = this.selected.defaultRounds ?? this.plugin.settings.researchDefaultRounds;
		this.maxRounds = rounds;
		if (this.roundsInput) this.roundsInput.value = String(rounds);
	}

	/** The selected workflow's steps as a compact vertical flow. */
	private renderStepPreview(): void {
		const el = this.stepsEl;
		if (!el) return;
		el.empty();
		const w = this.selected;

		w.steps.forEach((step, i) => {
			if (i > 0) el.createDiv({ cls: 'va-wf-arrow', text: '↓' });
			const card = el.createDiv({ cls: 'va-wf-step' });
			const head = card.createDiv({ cls: 'va-wf-step-head' });
			head.createSpan({
				cls: 'va-wf-step-id',
				text: w.steps.length > 1 ? `${i + 1} · ${step.id}` : step.id,
			});
			const badges = head.createDiv({ cls: 'va-wf-badges' });
			badges.createSpan({
				cls: 'va-wf-badge',
				text: `temp ${step.temperature ?? this.plugin.settings.temperature}`,
			});
			if (step.model) badges.createSpan({ cls: 'va-wf-badge', text: step.model });
			badges.createSpan({
				cls: 'va-wf-badge',
				text: step.tools ? `${step.tools.length} tools` : 'all tools',
			});
			badges.createSpan({
				cls: `va-wf-badge${step.approvals === 'ask' ? ' va-wf-badge-ask' : ''}`,
				text: step.approvals === 'ask' ? 'asks approval' : 'auto-deny',
			});
			const excerpt = step.prompt.replace(/\s+/g, ' ').trim();
			card.createDiv({
				cls: 'va-wf-step-prompt',
				text: excerpt.length > 180 ? excerpt.slice(0, 180) + '…' : excerpt,
			});
		});

		el.createDiv({
			cls: 'va-wf-loop',
			text: w.loop
				? '↻ repeats each round until finished, stopped, or the budget is used'
				: '→ single pass',
		});
	}

	/** Unfinished runs (frontmatter status ≠ done) in the runs folder, newest first. */
	private renderResumeList(contentEl: HTMLElement): void {
		const folder = normalizePath(this.plugin.settings.researchFolder);
		const prefix = folder ? `${folder}/` : '';
		const open = this.app.vault
			.getMarkdownFiles()
			.filter((f) => f.path.startsWith(prefix))
			.filter((f) => {
				const status: unknown = this.app.metadataCache.getFileCache(f)?.frontmatter?.status;
				return typeof status === 'string' && status !== 'done';
			})
			.sort((a, b) => b.stat.mtime - a.stat.mtime);
		if (!open.length) return;

		new Setting(contentEl).setName('Resume a previous run').setHeading();
		contentEl.createEl('p', {
			cls: 'va-import-desc',
			text: 'Continues an unfinished run note with its own workflow, using the rounds and delay set above.',
		});
		for (const f of open) {
			const fm = this.app.metadataCache.getFileCache(f)?.frontmatter ?? {};
			const noteWorkflow = workflowForNote(this.app, f, this.workflows);
			const row = contentEl.createDiv({ cls: 'va-research-resume' });
			row.createDiv({ text: f.basename });
			row.createDiv({
				cls: 'va-import-meta',
				text:
					`${Number(fm.rounds) || 0} rounds so far` +
					(noteWorkflow ? ` · ${noteWorkflow.name}` : ''),
			});
			row.onclick = () => {
				this.close();
				this.onStart({
					// Old research notes have no workflow field — the current
					// selection (default: deep research) takes over.
					workflow: noteWorkflow ?? this.selected,
					file: f,
					goal: '',
					maxRounds: this.maxRounds,
					delaySeconds: this.delaySeconds,
				});
			};
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
