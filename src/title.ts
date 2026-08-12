/**
 * Conversation naming: one cheap, tool-less model call that turns the opening
 * exchange into a short title, so saved transcripts read as
 * "2026-08-12 1432 Reworking the RAG chunker" instead of a truncated first
 * message.
 */
import { VaultAssistantSettings } from './settings';
import { chatCompletion } from './api/client';

/** Titles longer than this are clipped at a word boundary (the filename slug allows 40). */
const MAX_TITLE_CHARS = 40;
/** How much of the answer to show the namer; the topic is clear early on. */
const MAX_ANSWER_CHARS = 800;

const SYSTEM_PROMPT = [
	'You name chat conversations for a filing system.',
	'Reply with ONLY the title: 3 to 7 words naming the specific topic, in sentence case,',
	'no quotes, no trailing punctuation, no date, no prefix like "Title:".',
	'Name the subject matter, not the interaction (not "user asks about X" — just "X").',
].join(' ');

/** Lines a chatty model puts before the title it was asked for. */
const PREAMBLE = /^(?:sure|ok|okay|certainly|got it|of course|here(?:'s| is)\b.*)$/i;

/** Strip the quoting, labels and emphasis models wrap a title in. */
function stripDecoration(line: string): string {
	return line
		.trim()
		.replace(/^(?:title|conversation|name)\s*[:—-]\s*/i, '')
		.replace(/^["'“”‘’*#\-\s]+|["'“”‘’*\s]+$/g, '')
		.replace(/[.,;:!?]+$/, '')
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * Pick the title out of whatever the model replied. Small models like to lead
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
 * Ask the model to name a conversation from its opening exchange. Returns an
 * empty string when the call fails or the model says something unusable — the
 * caller then falls back to the first message.
 */
export async function suggestConversationTitle(
	settings: VaultAssistantSettings,
	userMessage: string,
	assistantAnswer = '',
): Promise<string> {
	const answer = assistantAnswer.trim().slice(0, MAX_ANSWER_CHARS);
	const exchange = answer
		? `Message:\n${userMessage}\n\nAnswer:\n${answer}`
		: `Message:\n${userMessage}`;

	try {
		const result = await chatCompletion(
			settings,
			[
				{ role: 'system', content: SYSTEM_PROMPT },
				{ role: 'user', content: exchange },
			],
			[],
			{ temperature: 0.2 },
		);
		return clampWords(cleanTitle(result.content), MAX_TITLE_CHARS);
	} catch (e) {
		console.warn('[vault-assistant] Could not name the conversation:', e);
		return '';
	}
}
