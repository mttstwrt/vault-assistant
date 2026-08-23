/**
 * A line diff for showing what a write did to a note.
 *
 * Common prefix and suffix are trimmed first, so the usual case — an append or
 * a small edit inside a long note — costs almost nothing, and only the changed
 * middle goes through the O(n×m) table. A middle too big for that is reported
 * as a wholesale replacement rather than left to grind.
 */

export type DiffKind = 'context' | 'add' | 'remove';

export interface DiffLine {
	kind: DiffKind;
	text: string;
}

export interface DiffHunk {
	lines: DiffLine[];
	/** Whether lines were skipped between this hunk and the previous one. */
	gapBefore: boolean;
}

export interface FileDiff {
	hunks: DiffHunk[];
	added: number;
	removed: number;
	/** True when the change was too large to diff line by line. */
	truncated: boolean;
}

/** Above this many changed lines on a side, fall back to a wholesale change. */
const MAX_DIFF_LINES = 1500;
/**
 * Unchanged lines kept either side of a change. Three, because markdown puts a
 * blank line under every heading: two would show the blank and lose the
 * heading that says where you are.
 */
const CONTEXT = 3;

function splitLines(text: string): string[] {
	if (!text) return [];
	const lines = text.split('\n');
	// A trailing newline is a property of the last line, not a line of its own.
	if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
	return lines;
}

/** Longest common subsequence of two line arrays, as a walk of edits. */
function lcsEdits(before: string[], after: string[]): DiffLine[] {
	const n = before.length;
	const m = after.length;
	// table[i][j] = LCS length of before[i..] and after[j..]
	const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			const row = table[i];
			const next = table[i + 1];
			if (!row || !next) continue;
			row[j] =
				before[i] === after[j]
					? (next[j + 1] ?? 0) + 1
					: Math.max(next[j] ?? 0, row[j + 1] ?? 0);
		}
	}

	const out: DiffLine[] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (before[i] === after[j]) {
			out.push({ kind: 'context', text: before[i] ?? '' });
			i++;
			j++;
		} else if ((table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0)) {
			out.push({ kind: 'remove', text: before[i] ?? '' });
			i++;
		} else {
			out.push({ kind: 'add', text: after[j] ?? '' });
			j++;
		}
	}
	for (; i < n; i++) out.push({ kind: 'remove', text: before[i] ?? '' });
	for (; j < m; j++) out.push({ kind: 'add', text: after[j] ?? '' });
	return out;
}

/** Keep the changed lines and a little context; note where lines were skipped. */
function toHunks(lines: DiffLine[]): DiffHunk[] {
	const keep = new Array<boolean>(lines.length).fill(false);
	lines.forEach((line, i) => {
		if (line.kind === 'context') return;
		for (let k = Math.max(0, i - CONTEXT); k <= Math.min(lines.length - 1, i + CONTEXT); k++) {
			keep[k] = true;
		}
	});

	const hunks: DiffHunk[] = [];
	let current: DiffLine[] = [];
	let skipped = false;
	let gapBefore = false;
	lines.forEach((line, i) => {
		if (keep[i]) {
			if (current.length === 0) gapBefore = skipped;
			current.push(line);
		} else if (current.length) {
			hunks.push({ lines: current, gapBefore });
			current = [];
			skipped = true;
		} else {
			skipped = true;
		}
	});
	if (current.length) hunks.push({ lines: current, gapBefore });
	return hunks;
}

/** Diff two versions of a file, line by line. */
export function diffLines(before: string, after: string): FileDiff {
	const a = splitLines(before);
	const b = splitLines(after);

	// Identical head and tail never need diffing — this is the whole trick for
	// appends, where the head is the entire old note.
	let head = 0;
	while (head < a.length && head < b.length && a[head] === b[head]) head++;
	let tail = 0;
	while (
		tail < a.length - head &&
		tail < b.length - head &&
		a[a.length - 1 - tail] === b[b.length - 1 - tail]
	) {
		tail++;
	}

	const midA = a.slice(head, a.length - tail);
	const midB = b.slice(head, b.length - tail);

	if (midA.length > MAX_DIFF_LINES || midB.length > MAX_DIFF_LINES) {
		return { hunks: [], added: midB.length, removed: midA.length, truncated: true };
	}

	const edits: DiffLine[] = [
		...a.slice(0, head).map((text): DiffLine => ({ kind: 'context', text })),
		...lcsEdits(midA, midB),
		...a.slice(a.length - tail).map((text): DiffLine => ({ kind: 'context', text })),
	];

	return {
		hunks: toHunks(edits),
		added: edits.filter((l) => l.kind === 'add').length,
		removed: edits.filter((l) => l.kind === 'remove').length,
		truncated: false,
	};
}
