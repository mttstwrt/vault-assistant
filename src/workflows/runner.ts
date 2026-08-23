import { App, TFile, moment, normalizePath } from 'obsidian';
import { VaultAssistantSettings } from '../settings';
import { ApprovalRequest, ApprovalResult, ChatMessage, FileChange, ToolCall } from '../types';
import { ExtraTool, runAgent } from '../agent';
import { buildSystemPrompt } from '../prompts';
import { conversationSlug, ensureFolder } from '../conversation';
import { McpManager } from '../mcp/manager';
import { RagIndexer } from '../rag/indexer';
import { WorkflowDef, WorkflowStep } from './schema';

export type WorkflowOutcome = 'done' | 'paused';

/** What the chat view needs to render a run. */
export interface WorkflowEvents {
	onAssistant(content: string): void;
	onToolCall(call: ToolCall): void;
	onToolResult(call: ToolCall, result: string): void;
	onError(message: string): void;
	/** Round separators, waits between rounds, and the run's outcome. */
	onInfo(text: string): void;
	/** Used only by steps with approvals: 'ask'; 'deny' steps never prompt. */
	requestApproval?: (req: ApprovalRequest) => Promise<ApprovalResult>;
	/** A file the run wrote, so the panel can show the diff. */
	onFileChange?: (change: FileChange) => void;
}

export interface WorkflowRunOptions {
	/** Path of the run note driving this run. */
	path: string;
	/** Rounds to run in this invocation; 0 = until stopped. */
	maxRounds: number;
	/** Pause between rounds, in seconds. */
	delaySeconds: number;
}

/** Expand settings-dependent placeholders inside workflow prompts and goals. */
export function expandPlaceholders(text: string, settings: VaultAssistantSettings): string {
	return text.replace(/\{\{goalsFile\}\}/g, settings.goalsFile);
}

/** Note-as-memory scaffolding shared by every workflow; steps add the task. */
function workflowPrompt(
	def: WorkflowDef,
	step: WorkflowStep,
	settings: VaultAssistantSettings,
): string {
	return [
		'',
		`--- Autonomous run: ${def.name} ---`,
		'You are in an autonomous workflow run: nobody is watching over your shoulder, and follow-up questions are impossible. The run happens in rounds, and each round starts fresh — the run note quoted in the user message is your only memory of previous rounds, so read it first and never redo work it already records.',
		'- If a write is denied, don\'t wait for permission — put the content in a wiki page instead.',
		'- End with a report: what you did, the NEW findings or results (with [[links]] to the notes and wiki pages involved), then a "Next steps" list for the following round. Your final message is appended to the run note automatically — never edit that note yourself.',
		'- Call finish_run only when the goal is fully and verifiably achieved. Open-ended goals (surface, monitor, keep expanding…) are never finished — for those, always end with next steps instead.',
		"--- This step's task ---",
		expandPlaceholders(step.prompt, settings),
	].join('\n');
}

/** Create a fresh run note for `goal` and return its path. */
export async function createRunNote(
	app: App,
	settings: VaultAssistantSettings,
	workflow: WorkflowDef,
	goal: string,
): Promise<string> {
	const stamp = moment().format('YYYY-MM-DD HHmm');
	const slug = conversationSlug(goal);
	const path = normalizePath(`${settings.researchFolder}/${slug ? `${stamp} ${slug}` : stamp}.md`);
	await ensureFolder(app, settings.researchFolder);
	const md = [
		'---',
		`created: ${moment().format('YYYY-MM-DD HH:mm')}`,
		'status: running',
		'rounds: 0',
		`workflow: ${workflow.id}`,
		'tags: [ai-research]',
		'---',
		'',
		'## 🎯 Goal',
		'',
		goal.trim(),
		'',
	].join('\n');
	await app.vault.create(path, md);
	return path;
}

/**
 * Drive an autonomous workflow run: each round re-reads the run note (goal +
 * past reports), executes the workflow's steps as bounded agent conversations,
 * and appends each step's final answer back to the note. The note is the run's
 * only memory, so runs survive restarts and any note whose status is not
 * "done" can be resumed later with a fresh budget.
 */
export class WorkflowRun {
	private stopRequested = false;
	private finishSummary: string | null = null;

	constructor(
		private app: App,
		private settings: VaultAssistantSettings,
		private saveSettings: () => Promise<void>,
		private mcp: McpManager,
		private rag: RagIndexer,
		private workflow: WorkflowDef,
		private opts: WorkflowRunOptions,
		private events: WorkflowEvents,
	) {}

	/** Request a stop; takes effect at the next model-call boundary. */
	stop(): void {
		this.stopRequested = true;
	}

	async run(): Promise<WorkflowOutcome> {
		const file = this.app.vault.getAbstractFileByPath(this.opts.path);
		if (!(file instanceof TFile)) throw new Error(`Run note not found: ${this.opts.path}`);

		let rounds = await this.readRounds(file);
		await this.setFrontmatter(file, { status: 'running', workflow: this.workflow.id });

		// A non-looping workflow is a single pass regardless of budget.
		const maxRounds = this.workflow.loop ? this.opts.maxRounds : 1;

		let done = false;
		let end = 'round budget used';
		let noReportStreak = 0;

		for (let i = 0; maxRounds === 0 || i < maxRounds; i++) {
			if (i > 0 && this.opts.delaySeconds > 0 && !this.stopRequested) {
				this.events.onInfo(`Next round in ${this.opts.delaySeconds}s…`);
				await this.sleep(this.opts.delaySeconds);
			}
			if (this.stopRequested) {
				end = 'stopped';
				break;
			}

			const round = rounds + 1;
			this.events.onInfo(`— Round ${round} —`);

			let anyReport = false;
			let anyResponse = false;
			for (const step of this.workflow.steps) {
				if (this.stopRequested) break;
				if (this.workflow.steps.length > 1) this.events.onInfo(`· Step: ${step.id}`);

				const { report, responded } = await this.runStep(file, round, step);
				anyResponse = anyResponse || responded;

				if (report) {
					anyReport = true;
					const label =
						this.workflow.steps.length > 1 ? `Round ${round} · ${step.id}` : `Round ${round}`;
					await this.app.vault.append(
						file,
						`\n## ${label} — ${moment().format('YYYY-MM-DD HH:mm')}\n\n${report}\n`,
					);
				}
				if (this.finishSummary !== null) break;
			}

			if (anyReport) {
				rounds = round;
				await this.setFrontmatter(file, { rounds: round });
				noReportStreak = 0;
			}

			if (this.finishSummary !== null) {
				await this.app.vault.append(
					file,
					`\n## ✅ Conclusion — ${moment().format('YYYY-MM-DD HH:mm')}\n\n${this.finishSummary}\n`,
				);
				done = true;
				break;
			}

			if (this.stopRequested) {
				end = 'stopped';
				break;
			}

			if (!anyReport) {
				// No assistant message at all means the model call itself failed
				// (already reported through onError) — don't hammer the endpoint.
				if (!anyResponse) {
					end = 'the model call failed';
					break;
				}
				noReportStreak++;
				if (noReportStreak >= 2) {
					end = 'two rounds ended without a report';
					break;
				}
				this.events.onInfo('Round ended without a report — trying one more round.');
			}

			if (!this.workflow.loop) {
				done = true;
				break;
			}
		}

		await this.setFrontmatter(file, { status: done ? 'done' : 'paused' });
		if (done) {
			this.events.onInfo(`${this.workflow.name} finished. ✅`);
			return 'done';
		}
		this.events.onInfo(
			`${this.workflow.name} paused (${end}). Resume "${file.basename}" anytime from the workflow button.`,
		);
		return 'paused';
	}

	/** Run one bounded agent conversation seeded from the run note. */
	private async runStep(
		file: TFile,
		round: number,
		step: WorkflowStep,
	): Promise<{ report: string | null; responded: boolean }> {
		const note = await this.app.vault.cachedRead(file);
		const history: ChatMessage[] = [
			{
				role: 'system',
				content:
					(await buildSystemPrompt(this.app, this.settings)) +
					workflowPrompt(this.workflow, step, this.settings),
			},
			{
				role: 'user',
				content: [
					`Workflow round ${round}. Continue working toward the goal in the run note below. The report sections are your own output from previous rounds and steps — build on them, don't repeat them.`,
					'',
					'--- Run note ---',
					note,
				].join('\n'),
			},
		];
		const baseline = history.length;

		const askUser = step.approvals === 'ask' ? this.events.requestApproval : undefined;
		const toolSet = step.tools ? new Set(step.tools) : null;

		await runAgent(
			this.app,
			this.settings,
			this.saveSettings,
			this.mcp,
			this.rag,
			new Set(), // runs never persist session write approvals across steps
			new Set(), // …nor session MCP approvals
			history,
			{
				onAssistant: (c) => this.events.onAssistant(c),
				onToolCall: (c) => this.events.onToolCall(c),
				onToolResult: (c, r) => this.events.onToolResult(c, r),
				onError: (m) => this.events.onError(m),
				requestApproval: askUser ?? (() => Promise.resolve('deny' as const)),
				onFileChange: (c) => this.events.onFileChange?.(c),
			},
			{
				extraTools: [this.finishTool()],
				shouldStop: () => this.stopRequested,
				toolFilter: toolSet ? (name) => toolSet.has(name) : undefined,
				maxSteps: step.maxSteps,
				overrides: { temperature: step.temperature, model: step.model },
			},
		);

		const added = history.slice(baseline);
		const last = added[added.length - 1];
		const report =
			last && last.role === 'assistant' && !last.toolCalls && last.content.trim()
				? last.content.trim()
				: null;
		return { report, responded: added.some((m) => m.role === 'assistant') };
	}

	private finishTool(): ExtraTool {
		return {
			spec: {
				name: 'finish_run',
				description:
					'End this workflow run because its goal is fully achieved. Only for goals with a concrete end state — open-ended goals are never finished. After calling it, give your final report as usual.',
				parameters: {
					type: 'object',
					properties: {
						summary: {
							type: 'string',
							description: 'A closing summary of what was achieved across the whole run.',
						},
					},
					required: ['summary'],
				},
			},
			run: (argsJson: string) => {
				let summary = '';
				try {
					const v = (JSON.parse(argsJson || '{}') as Record<string, unknown>).summary;
					if (typeof v === 'string') summary = v;
				} catch {
					// Malformed arguments still count as finishing.
				}
				this.finishSummary = summary.trim() || 'Run marked complete.';
				return Promise.resolve('Run marked complete. Write your final report now.');
			},
		};
	}

	/** The `rounds` counter from the note's frontmatter, straight from disk. */
	private async readRounds(file: TFile): Promise<number> {
		const content = await this.app.vault.cachedRead(file);
		if (!content.startsWith('---\n')) return 0;
		const fmEnd = content.indexOf('\n---\n', 4);
		if (fmEnd === -1) return 0;
		const n = /^rounds:\s*(\d+)\s*$/m.exec(content.slice(4, fmEnd))?.[1];
		return n ? parseInt(n, 10) : 0;
	}

	private async setFrontmatter(
		file: TFile,
		fields: Record<string, string | number>,
	): Promise<void> {
		await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
			Object.assign(fm, fields);
		});
	}

	/** Wait `seconds`, in 1s ticks so a stop request cuts the wait short. */
	private async sleep(seconds: number): Promise<void> {
		for (let i = 0; i < seconds && !this.stopRequested; i++) {
			await new Promise((r) => window.setTimeout(r, 1000));
		}
	}
}
