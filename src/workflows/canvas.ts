import { WorkflowDef, WorkflowStep } from './schema';

/**
 * Render a workflow as an Obsidian canvas (JSON Canvas format): one node per
 * step, edges for control flow, a loop-back edge for looping workflows.
 * One-way export — the workflow note's frontmatter stays the source of truth,
 * so regenerating overwrites the canvas.
 */

interface CanvasNode {
	id: string;
	type: 'text';
	text: string;
	x: number;
	y: number;
	width: number;
	height: number;
	color?: string;
}

interface CanvasEdge {
	id: string;
	fromNode: string;
	fromSide: 'top' | 'right' | 'bottom' | 'left';
	toNode: string;
	toSide: 'top' | 'right' | 'bottom' | 'left';
	label?: string;
}

const STEP_WIDTH = 400;
const STEP_GAP = 140;
const INFO_WIDTH = 460;
const INFO_HEIGHT = 200;

/** Rough text-node height so prompts of typical length fit without scrolling. */
function stepHeight(step: WorkflowStep): number {
	const lines = Math.ceil(step.prompt.length / 55) + 4;
	return Math.min(680, Math.max(260, lines * 26));
}

function stepText(step: WorkflowStep, index: number, total: number): string {
	const badges = [
		step.temperature !== undefined ? `temp ${step.temperature}` : 'temp (default)',
		step.model ? `model ${step.model}` : null,
		step.tools ? `tools: ${step.tools.join(', ')}` : 'all tools',
		step.approvals === 'ask' ? 'asks approval' : 'auto-deny writes',
		step.maxSteps ? `≤ ${step.maxSteps} tool rounds` : null,
	].filter(Boolean);
	const title = total > 1 ? `Step ${index + 1} — ${step.id}` : step.id;
	return [`## ${title}`, '', badges.map((b) => `\`${b}\``).join(' · '), '', '---', '', step.prompt].join(
		'\n',
	);
}

function infoText(def: WorkflowDef): string {
	return [
		`# ${def.name}`,
		'',
		def.description,
		'',
		def.loop
			? '**Looping** — the step chain repeats each round; the run note is the only memory between rounds.'
			: '**Single pass** — the steps run once.',
		'',
		'> Generated view. Edit the workflow *note* (frontmatter), not this canvas, then regenerate.',
	].join('\n');
}

export function workflowToCanvas(def: WorkflowDef): string {
	const nodes: CanvasNode[] = [
		{
			id: 'info',
			type: 'text',
			text: infoText(def),
			x: 0,
			y: -(INFO_HEIGHT + 100),
			width: INFO_WIDTH,
			height: INFO_HEIGHT,
			color: '6',
		},
	];
	const edges: CanvasEdge[] = [];

	const maxHeight = Math.max(...def.steps.map(stepHeight));
	def.steps.forEach((step, i) => {
		const height = stepHeight(step);
		nodes.push({
			id: `step-${i}`,
			type: 'text',
			text: stepText(step, i, def.steps.length),
			x: i * (STEP_WIDTH + STEP_GAP),
			// Center each card on the row so edges run straight.
			y: Math.round((maxHeight - height) / 2),
			width: STEP_WIDTH,
			height,
			color: step.approvals === 'ask' ? '3' : '4',
		});
		if (i > 0) {
			edges.push({
				id: `flow-${i}`,
				fromNode: `step-${i - 1}`,
				fromSide: 'right',
				toNode: `step-${i}`,
				toSide: 'left',
			});
		}
	});

	if (def.loop && def.steps.length > 0) {
		edges.push({
			id: 'loop',
			fromNode: `step-${def.steps.length - 1}`,
			fromSide: 'bottom',
			toNode: 'step-0',
			toSide: 'bottom',
			label: 'next round (re-reads the run note)',
		});
	}

	return JSON.stringify({ nodes, edges }, null, '\t');
}
