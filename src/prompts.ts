import { App } from 'obsidian';
import { VaultAssistantSettings } from './settings';
import { displayScopes, writeScopes } from './permissions';
import { buildMemorySection } from './memory';
import { buildWikiSection } from './wiki';
import { activeToolSpecs, researchToolSpecs } from './tools/vault-tools';

/**
 * Build the full system prompt: the user's base instructions, a live
 * description of the current folders and permissions so the model knows exactly
 * what it may touch, and the agent's operating memory for this vault.
 */
export async function buildSystemPrompt(app: App, settings: VaultAssistantSettings): Promise<string> {
	const readDesc = settings.readBlockPaths.length
		? 'your whole vault except a few private areas the user has blocked (those files are hidden from you)'
		: 'your whole vault';

	// Stated as environment rather than advice, because it is not negotiable:
	// models trained as coding agents otherwise spend rounds trying `ls` and
	// `cat` before they reach for the vault tools.
	const access = [
		'',
		'--- How you reach this vault ---',
		'You have no shell, no filesystem access and no network access. The tools listed for this request are your only way to see or change anything, and they act on the vault through Obsidian, not on files on disk.',
		`Vault tools: ${activeToolSpecs(settings)
			.map((t) => t.name)
			.join(', ')}${settings.mcpServers.some((s) => s.enabled) ? ', plus any MCP tools listed for this request' : ''}.`,
		'Paths are always relative to the vault root — "Notes/Ideas.md", never "/home/you/Vault/Notes/Ideas.md" or "C:\\...". There is no working directory, no "~", and no leading slash.',
	].join('\n');

	const env = [
		'',
		'--- Environment ---',
		`Conversations folder: ${settings.conversationsFolder}`,
		`Wiki folder: ${settings.wikiFolder}`,
		`You can READ: ${readDesc}.`,
		`You can WRITE freely inside: ${displayScopes(writeScopes(settings))}.`,
		'Writing anywhere else will pause and ask the user to approve it first, so only write outside these folders when the user has actually asked you to.',
	].join('\n');

	const memory = await buildMemorySection(app, settings);
	const wiki = await buildWikiSection(app, settings);

	return `${settings.systemPrompt}\n${access}\n${env}${memory}${wiki}`;
}

/**
 * What the research pass is for and how its handover has to be written. It
 * answers nobody — its whole output is read by another model that cannot see
 * the vault it just looked at, so the two things that matter are that it looks
 * before it guesses, and that what it hands over is quoted rather than
 * remembered.
 */
const RESEARCH_INSTRUCTIONS = [
	"You are the research step for an assistant that is about to answer the user's message in this Obsidian vault. It will not see your tools, your searches or your reasoning — only the final message you write.",
	'',
	'FIRST, decide whether this message needs anything from the vault at all. Most do not. A conversation is mostly follow-ups, and every pass that runs is a wait the user sits through before their answer starts, so the decision to research has to be earned.',
	'',
	'Call no_research_needed, and do nothing else, when:',
	'- The message is about the conversation rather than the vault: shorten that, rewrite it, try again, explain what you just said, why did you do it that way.',
	'- It is an acknowledgement, small talk, or an instruction that needs no knowledge of the vault: thanks, yes, go ahead, stop, do the other one.',
	'- It follows up on something already in the conversation above, or already handed over by the last pass. The assistant can see both; collecting them again costs a wait and adds nothing.',
	'- Answering it needs no vault at all — a general question that happens to have been asked here.',
	'',
	'Research it when the message needs something from the vault that is not already in front of the assistant: a new subject, a note nobody has opened yet, a detail the last handover did not carry.',
	'',
	'When you are unsure about a message that names something in the vault, research it. When you are unsure about anything else, skip: a missing note costs one tool call in the answer, while a needless pass costs the wait every time.',
	'If you have no tools to call, reply with exactly NO_CONTEXT_NEEDED and nothing else.',
	'',
	'If you are researching, how to work:',
	'- Look before you guess. Start from what is there: list a likely folder, search for a word the user actually used, open the wiki index. Never assume a note exists because its name sounds right.',
	'- Follow what you find. A note that mentions another note is a lead worth opening.',
	'- Read the notes, not just their names. A filename is not evidence of what is in a file.',
	'- Do not collect again what the last handover already carried. Look for what is missing from it.',
	'- Stop when you have enough, or once you have established that there is nothing relevant. Searching for its own sake costs the user an answer.',
	'',
	'Then write the handover, which is the only thing that survives:',
	'- Open with one or two sentences: what you looked for, and anything relevant you looked for and could not find. That absence is worth as much as a hit.',
	"- Then, for each note that matters, put its exact vault path on a line of its own and quote the passages that bear on the user's message underneath it, verbatim. Do not paraphrase, summarise, correct or tidy them — a quote cannot be wrong about what a note says, and a summary can.",
	'- Quote only what bears on the message. A whole note is rarely the answer.',
	'- If you searched and there is genuinely nothing relevant in the vault, call no_research_needed instead of writing up nothing.',
].join('\n');

/**
 * The system prompt for the context pre-pass. Shares the vault's boundary,
 * memory and wiki map with the main prompt — the map is most of what stops the
 * pass guessing — but not the user's own instructions, which are about
 * answering, nor the write scopes, which it has no tools to act on.
 */
export async function buildResearchPrompt(
	app: App,
	settings: VaultAssistantSettings,
): Promise<string> {
	const readDesc = settings.readBlockPaths.length
		? 'your whole vault except a few private areas the user has blocked (those files are hidden from you)'
		: 'your whole vault';

	const access = [
		'',
		'--- How you reach this vault ---',
		'You have no shell, no filesystem access and no network access. The tools listed for this request are your only way to see anything, and they act on the vault through Obsidian, not on files on disk.',
		`Vault tools: ${researchToolSpecs(settings)
			.map((t) => t.name)
			.join(', ')}.`,
		'They only read. You cannot change a note in this step, and nothing you say here reaches the user directly.',
		'no_research_needed is offered alongside them and ends this step without collecting anything.',
		'Paths are always relative to the vault root — "Notes/Ideas.md", never "/home/you/Vault/Notes/Ideas.md" or "C:\\...". There is no working directory, no "~", and no leading slash.',
	].join('\n');

	const env = [
		'',
		'--- Environment ---',
		`Wiki folder: ${settings.wikiFolder}`,
		`You can READ: ${readDesc}.`,
	].join('\n');

	const memory = await buildMemorySection(app, settings);
	const wiki = await buildWikiSection(app, settings);

	return `${RESEARCH_INSTRUCTIONS}\n${access}\n${env}${memory}${wiki}`;
}
