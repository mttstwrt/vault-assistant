/**
 * What the plugin stores, and what it stores by default.
 *
 * Shape only: the tab that edits these lives in ./ui/settings-tab with the rest
 * of the views, and the agent's prompt text in ./system-prompt. Keeping this
 * module free of both is what lets everything import the settings type without
 * pulling a settings *screen* along with it.
 */
import { DEFAULT_SYSTEM_PROMPT } from './system-prompt';

/**
 * One configured MCP server. stdio uses command/args/env; http uses
 * url/headers; plugin uses pluginId (another installed plugin's tool api,
 * called in-process — no server, works on mobile).
 */
export interface McpServerConfig {
	id: string;
	name: string;
	enabled: boolean;
	/** Trusted servers' tools run without an approval prompt. */
	trusted: boolean;
	transport: 'stdio' | 'http' | 'plugin';
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	url?: string;
	headers?: Record<string, string>;
	/** Plugin id whose `api` exposes the tools (transport: 'plugin'). */
	pluginId?: string;
}

export interface VaultAssistantSettings {
	// --- Model endpoint ---
	baseUrl: string;
	apiKey: string;
	model: string;
	/**
	 * Sampling temperature, or null to send none and let the endpoint apply its
	 * own. Null rather than a number-that-means-unset, because a plugin default
	 * is indistinguishable from a choice once it has been saved — and silently
	 * overriding `llama-server --temp 0.4` with a value nobody picked is what
	 * that ambiguity costs.
	 */
	temperature: number | null;
	maxSteps: number;
	/** Merge extraBodyParams into every chat request (llama.cpp dynatemp etc.). */
	useExtraBodyParams: boolean;
	/** JSON object of extra request-body fields, e.g. {"dynatemp_range": 0.4}. */
	extraBodyParams: string;
	/** Stream answers token by token, so they can be read and interrupted early. */
	streamResponses: boolean;
	/** Keep the thinking section expanded while the model reasons. */
	expandThinking: boolean;
	/** OpenAI-style presence_penalty (-2 to 2), or null to send none. */
	presencePenalty: number | null;
	/** Repetition penalty (higher discourages repeats), or null to send none. */
	repetitionPenalty: number | null;

	// --- Agent behaviour ---
	systemPrompt: string;
	/** Run a cheap query-expansion + vault-search pass before each new message. */
	usePrePass: boolean;
	/**
	 * Tell the agent which notes are open and which one is focused (and expose
	 * the open_files tool), so "this note" resolves without naming a file.
	 * Blocked folders are never listed.
	 */
	useOpenFiles: boolean;
	/**
	 * Resolve [[links]] the user types in the chat box and attach the note (or
	 * the #section) to their message, so the agent does not spend a tool round
	 * fetching what they already named. Blocked folders are never attached.
	 */
	expandTypedLinks: boolean;

	// --- Folder permissions ---
	readBlockPaths: string[];
	writePaths: string[];
	conversationsFolder: string;
	wikiFolder: string;
	autoSaveConversations: boolean;
	/** Let the model title each saved conversation (one extra cheap call per chat). */
	nameConversations: boolean;
	/** Let the model file each saved conversation into a folder (shares that call). */
	fileConversations: boolean;

	// --- Operating memory ---
	useMemory: boolean;
	memoryFile: string;

	// --- Wiki ---
	/** Title of the curated entry page inside the wiki folder. */
	wikiHomeNote: string;
	/** Inject a compact pointer to the wiki Home page at session start. */
	useWikiIndex: boolean;

	// --- Workflows ---
	/** Where workflow-run notes (goal + round reports) live. Always writable. */
	researchFolder: string;
	/** Where workflow definition notes live. Always writable. */
	workflowsFolder: string;
	/** Default rounds budget offered when starting a run (0 = until stopped). */
	researchDefaultRounds: number;
	/** Default pause between rounds, in seconds. */
	researchDefaultDelaySeconds: number;
	/** The goals note workflows may reference via {{goalsFile}}. Always readable/writable. */
	goalsFile: string;

	// --- Scheduled runs ---
	scheduleEnabled: boolean;
	/** Workflow id to run on the schedule. */
	scheduleWorkflowId: string;
	/** Hours between scheduled runs. */
	scheduleEveryHours: number;
	/** Goal used when a scheduled run starts a fresh run note. */
	scheduleGoal: string;
	/** Epoch ms of the last scheduled run start (internal). */
	lastScheduledRun: number;
	/** Human-readable outcome of the last scheduled run (internal). */
	lastScheduledOutcome: string;

	// --- Semantic search (RAG) ---
	/** Master opt-in: embeddings send note contents to the embed endpoint. */
	useRag: boolean;
	embedModel: string;
	/** Optional override; empty = use the chat baseUrl. */
	embedBaseUrl: string;
	/** Optional override; empty = use the chat apiKey. */
	embedApiKey: string;
	ragTopK: number;
	/** Also embed wiki pages, so semantic search lands on curated pages. */
	ragIndexWiki: boolean;
	/** Also embed saved conversations (filtered: user turns + final answers). */
	ragIndexConversations: boolean;

	// --- MCP ---
	mcpServers: McpServerConfig[];
	/** One-time seeding of the disabled Life Tracker plugin-server entry. */
	seededLifeTrackerServer: boolean;
}

export const DEFAULT_SETTINGS: VaultAssistantSettings = {
	baseUrl: 'http://localhost:11434/v1',
	apiKey: '',
	model: 'llama3.1',
	// Unset: the endpoint's own sampling applies until you say otherwise.
	temperature: null,
	maxSteps: 12,
	useExtraBodyParams: false,
	extraBodyParams: '{\n  "dynatemp_range": 0.4,\n  "dynatemp_exponent": 1.0\n}',
	streamResponses: true,
	expandThinking: true,
	presencePenalty: null,
	repetitionPenalty: null,
	systemPrompt: DEFAULT_SYSTEM_PROMPT,
	usePrePass: false,
	useOpenFiles: true,
	expandTypedLinks: true,
	readBlockPaths: [],
	writePaths: [],
	conversationsFolder: 'AI/Conversations',
	wikiFolder: 'AI/Wiki',
	autoSaveConversations: true,
	nameConversations: true,
	fileConversations: false,
	useMemory: true,
	memoryFile: 'AI/Memory.md',
	wikiHomeNote: 'Home',
	useWikiIndex: true,
	researchFolder: 'AI/Research',
	workflowsFolder: 'AI/Workflows',
	researchDefaultRounds: 10,
	researchDefaultDelaySeconds: 0,
	goalsFile: 'AI/Goals.md',
	scheduleEnabled: false,
	scheduleWorkflowId: 'life-coach',
	scheduleEveryHours: 24,
	scheduleGoal:
		'Act as my life coach: review my Life Tracker data against my goals in {{goalsFile}}, call out imbalances, and plan tomorrow.',
	lastScheduledRun: 0,
	lastScheduledOutcome: '',
	useRag: false,
	embedModel: 'nomic-embed-text',
	embedBaseUrl: '',
	embedApiKey: '',
	ragTopK: 8,
	ragIndexWiki: false,
	ragIndexConversations: false,
	mcpServers: [],
	seededLifeTrackerServer: false,
};

// The tab that edits all of this; re-exported so main.ts has one import.
export { VaultAssistantSettingTab } from './ui/settings-tab';
