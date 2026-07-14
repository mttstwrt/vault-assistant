import { WorkflowDef, WorkflowStep } from './schema';

/**
 * Built-in workflow presets. "Create workflow preset" copies one into the
 * workflows folder as a note the user can edit; an edited copy with the same
 * id shadows the built-in in the picker.
 */
export const WORKFLOW_PRESETS: WorkflowDef[] = [
	{
		id: 'deep-research',
		name: 'Deep research',
		description:
			'Autonomous multi-round research toward a goal. Insights accumulate in the wiki; each round builds on the last.',
		loop: true,
		steps: [
			{
				id: 'research',
				prompt: [
					'Pick the most valuable next thread toward the goal (the previous round\'s "Next steps" is a good start) and pursue it with your tools.',
					'Save durable insights to the wiki as you go, and link them in.',
				].join('\n'),
				temperature: 0.8,
				approvals: 'deny',
			},
		],
		source: 'builtin',
	},
	{
		id: 'wiki-gardener',
		name: 'Wiki gardener',
		description:
			'Maintenance sweeps over the wiki: link orphans in, repair broken links, merge duplicates, expand thin pages.',
		loop: true,
		defaultRounds: 3,
		defaultGoal:
			'Tend the wiki: link orphans in, repair broken links, merge duplicates, and expand the thinnest pages.',
		steps: [
			{
				id: 'garden',
				prompt: [
					'Run list_wiki to audit the wiki: orphan pages, broken [[links]], duplicate or thin pages.',
					'Fix the most valuable few problems this round: link orphans into Home and related pages, repair or remove broken links, merge duplicates, and expand at most one thin page with content grounded in the vault.',
					'Keep the Home page curated and small.',
				].join('\n'),
				temperature: 0.3,
				approvals: 'deny',
			},
		],
		source: 'builtin',
	},
	{
		id: 'life-coach',
		name: 'Life coach',
		description:
			'Reviews your Life Tracker data against your goals note, calls out imbalances candidly, and plans adjustments. Built for a recurring schedule.',
		loop: true,
		defaultRounds: 1,
		defaultGoal:
			'Act as my life coach: review my Life Tracker data against my goals in {{goalsFile}}, call out imbalances, and plan tomorrow.',
		steps: [
			{
				id: 'assess',
				prompt: [
					'Build an honest picture of how the user is actually doing:',
					'1. Read their goals note at {{goalsFile}}. If it does not exist, create it with a short starter template (sections: Goals, Priorities, Constraints) and say so in your report.',
					'2. Pull the tracker state: call mcp__lifetracker__get_summaries, then mcp__lifetracker__query_events for the last 7 days. If those tools are unavailable, read the definition files under the LifeTracker folder instead.',
					'3. Compare reality against the goals: on track, slipping, overdue, and imbalances — too much of one activity, neglected areas, streaks about to break.',
					'Report the facts with numbers and [[links]]. No coaching yet — this step is the evidence.',
				].join('\n'),
				temperature: 0.3,
				approvals: 'deny',
			},
			{
				id: 'coach',
				prompt: [
					"Using the assessment above (in the run note), coach the user like a good trainer would — candid, specific, no cheerleading:",
					'- Call out what they are overdoing and what they are neglecting, and say it plainly.',
					'- Acknowledge real wins (streaks kept, goals hit) in one or two lines.',
					'- Propose concrete adjustments: schedule tomorrow\'s most important blocks with mcp__lifetracker__plan_item, and suggest cadence or goal changes where the data says the current target is wrong.',
					'- If a durable pattern emerged (e.g. "workouts always slip on meeting-heavy days"), save it to the wiki and link it.',
					'End the report with the three most important actions for tomorrow.',
				].join('\n'),
				temperature: 0.7,
				approvals: 'deny',
			},
		],
		source: 'builtin',
	},
	{
		id: 'weekly-review',
		name: 'Weekly review',
		description:
			'One pass: gather the week from daily notes and conversations, then write a review note with themes, wins, and loose ends.',
		loop: false,
		defaultGoal:
			'Review the past week: gather what happened from my daily notes and conversations, then write the weekly review note.',
		steps: [
			{
				id: 'gather',
				prompt: [
					"Collect this week's raw material: read the last 7 days of daily notes and any recent conversations or notes that changed.",
					"Report a structured digest — activities, themes, wins, problems, loose ends — each with [[links]] to the source notes. Don't interpret yet; be complete and factual.",
				].join('\n'),
				temperature: 0.4,
				approvals: 'deny',
			},
			{
				id: 'review',
				prompt: [
					"Using the gathered digest in the run note, write the weekly review: the week's themes, what went well, what stalled, and every loose end turned into a concrete next step.",
					'Save the review as a wiki page (link it into Home or a Reviews index page) and report where it lives.',
				].join('\n'),
				temperature: 0.8,
				approvals: 'deny',
			},
		],
		source: 'builtin',
	},
];

/** YAML-quote a scalar defensively. */
function yamlString(s: string): string {
	return JSON.stringify(s);
}

/** Indented YAML block scalar for multi-line prompts. */
function yamlBlock(s: string, indent: string): string {
	const lines = s.split('\n').map((l) => `${indent}${l}`);
	return `|\n${lines.join('\n')}`;
}

function stepToYaml(step: WorkflowStep): string {
	const lines = [`  - id: ${yamlString(step.id)}`];
	lines.push(`    prompt: ${yamlBlock(step.prompt, '      ')}`);
	if (step.temperature !== undefined) lines.push(`    temperature: ${step.temperature}`);
	if (step.model !== undefined) lines.push(`    model: ${yamlString(step.model)}`);
	if (step.tools) lines.push(`    tools: [${step.tools.map(yamlString).join(', ')}]`);
	if (step.maxSteps !== undefined) lines.push(`    maxSteps: ${step.maxSteps}`);
	lines.push(`    approvals: ${step.approvals}`);
	return lines.join('\n');
}

/** Serialize a preset as an editable workflow note (frontmatter + doc body). */
export function presetToNote(def: WorkflowDef): string {
	const fm = [
		'---',
		`name: ${yamlString(def.name)}`,
		`description: ${yamlString(def.description)}`,
		`loop: ${def.loop}`,
		...(def.defaultRounds !== undefined ? [`defaultRounds: ${def.defaultRounds}`] : []),
		...(def.defaultDelaySeconds !== undefined
			? [`defaultDelaySeconds: ${def.defaultDelaySeconds}`]
			: []),
		...(def.defaultGoal !== undefined ? [`defaultGoal: ${yamlString(def.defaultGoal)}`] : []),
		'steps:',
		...def.steps.map(stepToYaml),
		'---',
	].join('\n');

	const body = [
		'',
		`# ${def.name}`,
		'',
		def.description,
		'',
		'This note *is* the workflow: the frontmatter above defines its steps, and this copy shadows the built-in preset with the same name. Edit freely — per-step `prompt`, `temperature`, `model`, `tools` (allowlist), `maxSteps`, and `approvals` (`deny` = fully autonomous, `ask` = pause for approval on out-of-scope writes).',
		'',
		'Start it from the workflow button (telescope) in the chat panel.',
		'',
	].join('\n');

	return fm + body;
}
