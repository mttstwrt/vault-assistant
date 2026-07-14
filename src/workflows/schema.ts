import { App, TFile, normalizePath } from 'obsidian';
import { VaultAssistantSettings } from '../settings';

/** One bounded agent conversation inside a workflow round. */
export interface WorkflowStep {
	id: string;
	/** Task instructions appended to the system prompt for this step. */
	prompt: string;
	/** Sampling temperature for this step; falls back to the global setting. */
	temperature?: number;
	/** Model override for this step; falls back to the global setting. */
	model?: string;
	/** Tool-name allowlist. Omitted = every active tool. */
	tools?: string[];
	/** Cap on tool-call rounds for this step; falls back to the global setting. */
	maxSteps?: number;
	/** 'deny' = autonomous (out-of-scope writes auto-denied); 'ask' = prompt the user. */
	approvals: 'deny' | 'ask';
}

export interface WorkflowDef {
	/** Slug: preset id, or the note basename for vault workflows. */
	id: string;
	name: string;
	description: string;
	/** True: repeat the step list round after round until finished/stopped/budget. False: one pass. */
	loop: boolean;
	/** Rounds budget suggested when starting (0 = until stopped). */
	defaultRounds?: number;
	defaultDelaySeconds?: number;
	/** Pre-filled goal for self-describing workflows; {{goalsFile}} expands. */
	defaultGoal?: string;
	steps: WorkflowStep[];
	source: 'builtin' | 'vault';
	/** Vault note path when source === 'vault'. */
	path?: string;
}

function asString(v: unknown): string | undefined {
	return typeof v === 'string' && v.trim() ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
	return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * Validate a workflow note's frontmatter. Returns an error string instead of
 * throwing so callers can surface bad notes without breaking the picker.
 */
export function parseWorkflowFrontmatter(
	fm: Record<string, unknown>,
	fallbackId: string,
): { workflow?: WorkflowDef; error?: string } {
	const rawSteps = fm.steps;
	if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
		return { error: 'frontmatter needs a non-empty "steps" list' };
	}

	const steps: WorkflowStep[] = [];
	for (let i = 0; i < rawSteps.length; i++) {
		const raw = rawSteps[i] as Record<string, unknown>;
		if (!raw || typeof raw !== 'object') return { error: `step ${i + 1} is not a mapping` };
		const prompt = asString(raw.prompt);
		if (!prompt) return { error: `step ${i + 1} is missing a "prompt"` };
		const tools = Array.isArray(raw.tools)
			? raw.tools.filter((t): t is string => typeof t === 'string')
			: undefined;
		steps.push({
			id: asString(raw.id) ?? `step-${i + 1}`,
			prompt,
			temperature: asNumber(raw.temperature),
			model: asString(raw.model),
			tools,
			maxSteps: asNumber(raw.maxSteps),
			approvals: raw.approvals === 'ask' ? 'ask' : 'deny',
		});
	}

	return {
		workflow: {
			id: fallbackId,
			name: asString(fm.name) ?? fallbackId,
			description: asString(fm.description) ?? '',
			loop: fm.loop !== false,
			defaultRounds: asNumber(fm.defaultRounds),
			defaultDelaySeconds: asNumber(fm.defaultDelaySeconds),
			defaultGoal: asString(fm.defaultGoal),
			steps,
			source: 'vault',
		},
	};
}

/**
 * All available workflows: built-in presets plus any parseable workflow notes
 * in the workflows folder (a note qualifies by having `steps` in frontmatter).
 * A vault note with the same id as a preset shadows it, so users can copy a
 * preset out and customise it without seeing both.
 */
export function loadWorkflows(
	app: App,
	settings: VaultAssistantSettings,
	presets: WorkflowDef[],
): { workflows: WorkflowDef[]; warnings: string[] } {
	const folder = normalizePath(settings.workflowsFolder);
	const prefix = folder ? `${folder}/` : '';
	const fromVault: WorkflowDef[] = [];
	const warnings: string[] = [];

	for (const file of app.vault.getMarkdownFiles()) {
		if (!file.path.startsWith(prefix)) continue;
		const fm = app.metadataCache.getFileCache(file)?.frontmatter;
		if (!fm || fm.steps === undefined) continue;
		const { workflow, error } = parseWorkflowFrontmatter(fm, file.basename);
		if (error) {
			warnings.push(`${file.path}: ${error}`);
			continue;
		}
		if (workflow) fromVault.push({ ...workflow, path: file.path });
	}

	const vaultIds = new Set(fromVault.map((w) => w.id));
	const workflows = [...fromVault, ...presets.filter((p) => !vaultIds.has(p.id))];
	workflows.sort((a, b) => a.name.localeCompare(b.name));
	return { workflows, warnings };
}

/** Resolve the workflow a run note was started with (frontmatter `workflow`). */
export function workflowForNote(
	app: App,
	file: TFile,
	workflows: WorkflowDef[],
): WorkflowDef | undefined {
	const id = app.metadataCache.getFileCache(file)?.frontmatter?.workflow as unknown;
	if (typeof id !== 'string') return undefined;
	return workflows.find((w) => w.id === id);
}
