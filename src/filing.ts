/**
 * Conversation naming and filing: one cheap, tool-less model call that turns
 * the opening exchange into a short title and, when filing is on, the name of
 * the folder the transcript belongs in — so saved conversations read as
 * "Obsidian setup/2026-08-12 1432 Reworking the RAG chunker" instead of a flat
 * list of truncated first messages.
 *
 * Naming and filing are two halves of one question — what is this conversation,
 * and where does it go — so they are one call, and either half can be off. With
 * filing off the prompt and the parsing are exactly what they were when this
 * module only named things, so the older feature cannot regress.
 *
 * What comes back is model output derived from vault contents, i.e. untrusted:
 * the folder is a *name*, never a path, and newConversationPath slugs it before
 * it can become one.
 */
import { VaultAssistantSettings } from './settings';
import { chatCompletion } from './api/client';

/** Titles longer than this are clipped at a word boundary (the filename slug allows 40). */
const MAX_TITLE_CHARS = 40;
/** Folders are meant to be 1–3 words; a long one is a model ignoring that. */
const MAX_FOLDER_CHARS = 30;
/** How much of the answer to show the namer; the topic is clear early on. */
const MAX_ANSWER_CHARS = 800;
/** Existing folders offered for reuse. Enough to recognise one, cheap to send. */
const MAX_FOLDERS = 40;

const TITLE_PROMPT = [
	'You name chat conversations for a filing system.',
	'Reply with ONLY the title: 3 to 7 words naming the specific topic, in sentence case,',
	'no quotes, no trailing punctuation, no date, no prefix like "Title:".',
	'Name the subject matter, not the interaction (not "user asks about X" — just "X").',
].join(' ');

const FOLDER_PROMPT = [
	'You file chat conversations into folders.',
	'Reply with ONLY the folder name: 1 to 3 words naming the subject of the conversation,',
	'in sentence case, no quotes, no trailing punctuation, no path, no prefix like "Folder:".',
	'Name the subject matter, not the interaction.',
].join(' ');

const BOTH_PROMPT = [
	'You name and file chat conversations for a filing system.',
	'Reply with exactly two lines and nothing else:',
	'Title: 3 to 7 words naming the specific topic, in sentence case, no quotes, no trailing punctuation.',
	'Folder: the one folder this conversation belongs in, naming its subject in 1 to 3 words, sentence case.',
	'Name the subject matter, not the interaction (not "user asks about X" — just "X").',
].join('\n');

/** Lines a chatty model puts before the title it was asked for. */
const PREAMBLE = /^(?:sure|ok|okay|certainly|got it|of course|here(?:'s| is)\b.*)$/i;

/** What to ask for. `folders` is the list that already exists; null = don't file. */
export interface FilingRequest {
	title: boolean;
	folders: string[] | null;
}

export interface Filing {
	/** Empty when naming is off, or the model said nothing usable. */
	title: string;
	/** Empty when filing is off, or nothing usable came back — the root, then. */
	folder: string;
}

/** Strip the quoting, labels and emphasis models wrap an answer in. */
function stripDecoration(line: string): string {
	return line
		.trim()
		.replace(/^(?:title|conversation|name|folder)\s*[:—-]\s*/i, '')
		.replace(/^["'“”‘’*#\-\s]+|["'“”‘’*\s]+$/g, '')
		.replace(/[.,;:!?]+$/, '')
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * Pick the answer out of whatever the model replied. Small models like to lead
 * with "Sure!" or "Here's a title:", so a line that is only preamble is passed
 * over — unless it is all we got.
 */
function cleanTitle(raw: string): string {
	const lines = raw.split('\n').map(stripDecoration).filter(Boolean);
	const title = lines.find((l) => !PREAMBLE.test(l) && !l.endsWith(':'));
	return title ?? lines[0] ?? '';
}

/** Clip to at most `max` characters without cutting a word in half. */
function clampWords(text: string, max: number): string {
	if (text.length <= max) return text;
	const cut = text.slice(0, max);
	const lastSpace = cut.lastIndexOf(' ');
	return (lastSpace > max / 2 ? cut.slice(0, lastSpace) : cut).trim();
}

/**
 * A labelled line as it actually arrives. Models that were asked for
 * `Title: …` answer `- **Title**: …` often enough that the bullet and the
 * emphasis have to come off before the label can be recognised.
 */
function undecorate(line: string): string {
	return line
		.replace(/^[-*•\s]+/, '')
		.replace(/\*\*/g, '')
		.trim();
}

/** The `Label: value` line the two-line reply was asked for, if the model obliged. */
function labelled(lines: string[], label: string): string {
	const prefix = new RegExp(`^${label}\\s*[:—-]\\s*`, 'i');
	const line = lines.map(undecorate).find((l) => prefix.test(l));
	return line ? stripDecoration(line.replace(prefix, '')) : '';
}

/**
 * What the model is asked. The existing folders are part of the instruction
 * rather than the exchange: reusing one is the rule, and a fresh vault where
 * there are none simply doesn't get the line — it is being asked to start the
 * vocabulary, not to match a list of nothing.
 */
function systemPrompt(want: FilingRequest): string {
	if (!want.folders) return TITLE_PROMPT;
	const base = want.title ? BOTH_PROMPT : FOLDER_PROMPT;
	const existing = want.folders.slice(0, MAX_FOLDERS);
	if (!existing.length) return base;
	return [
		base,
		`Folders that already exist: ${existing.join(', ')}.`,
		'Reuse one of them whenever it fits; invent a new folder only when none does.',
	].join('\n');
}

/**
 * Ask the model to name a conversation from its opening exchange, and to say
 * which folder it belongs in. Anything it fails to answer usably comes back
 * empty, and the caller falls back to the first message and the root folder.
 */
export async function suggestFiling(
	settings: VaultAssistantSettings,
	userMessage: string,
	assistantAnswer: string,
	want: FilingRequest,
): Promise<Filing> {
	const nothing: Filing = { title: '', folder: '' };
	if (!want.title && !want.folders) return nothing;

	const answer = assistantAnswer.trim().slice(0, MAX_ANSWER_CHARS);
	const exchange = answer
		? `Message:\n${userMessage}\n\nAnswer:\n${answer}`
		: `Message:\n${userMessage}`;

	let raw: string;
	try {
		const result = await chatCompletion(
			settings,
			[
				{ role: 'system', content: systemPrompt(want) },
				{ role: 'user', content: exchange },
			],
			[],
			{ temperature: 0.2 },
		);
		raw = result.content;
	} catch (e) {
		console.warn('[vault-assistant] Could not name the conversation:', e);
		return nothing;
	}

	if (!want.folders) return { title: clampWords(cleanTitle(raw), MAX_TITLE_CHARS), folder: '' };
	if (!want.title) return { title: '', folder: clampWords(cleanTitle(raw), MAX_FOLDER_CHARS) };

	// Both halves: the labelled lines the two-line format asks for. A model that
	// ignores the format still usually says the title, so what is left once the
	// folder line is taken out is read the way a title-only reply would be.
	const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
	const folder = labelled(lines, 'folder');
	const rest = lines.filter((l) => !/^folder\s*[:—-]/i.test(undecorate(l)));
	const title = labelled(lines, 'title') || cleanTitle(rest.join('\n'));
	return {
		title: clampWords(title, MAX_TITLE_CHARS),
		folder: clampWords(folder, MAX_FOLDER_CHARS),
	};
}
