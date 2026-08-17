import { App, PluginSettingTab, Setting, TextComponent } from 'obsidian';
import type VaultAssistantPlugin from './main';
import { filterModels, listModels, modelLabel } from './api/models';
import { loadWorkflows } from './workflows/schema';
import { WORKFLOW_PRESETS } from './workflows/presets';

/** The two model fields that can be filled from a discovered list. */
type PickerKind = 'chat' | 'embed';

/**
 * One spelling per endpoint, so a trailing slash doesn't look like a different
 * server when caching what it serves.
 */
function canonicalUrl(url: string): string {
	return url.trim().replace(/\/+$/, '');
}

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
	temperature: number;
	maxSteps: number;
	/** Merge extraBodyParams into every chat request (llama.cpp dynatemp etc.). */
	useExtraBodyParams: boolean;
	/** JSON object of extra request-body fields, e.g. {"dynatemp_range": 0.4}. */
	extraBodyParams: string;
	/** Stream answers token by token, so they can be read and interrupted early. */
	streamResponses: boolean;
	/** Keep the thinking section expanded while the model reasons. */
	expandThinking: boolean;

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

	// --- Folder permissions ---
	readBlockPaths: string[];
	writePaths: string[];
	conversationsFolder: string;
	wikiFolder: string;
	autoSaveConversations: boolean;
	/** Let the model title each saved conversation (one extra cheap call per chat). */
	nameConversations: boolean;

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

export const DEFAULT_SYSTEM_PROMPT = `You are an AI assistant embedded inside the user's Obsidian vault. You can read, search, and (only within permitted folders) write notes using the provided tools, the same way a coding agent works inside a code repository.

Guidelines:
- Treat the user's personal notes as READ-ONLY context. Never modify a note unless the user explicitly asks you to edit that specific file, and only if it is in a writable folder.
- Your "Operating memory" (shown below, if present) is what you already know about how THIS vault is organised — where data lives, the formats and conventions the user uses, and corrections they have given you. Trust it and act on it before exploring. When you learn a durable fact like this, or the user corrects you (e.g. "habits are tracked here now, not there"), save it with the remember tool so you don't relearn it next time. Keep that memory short and high-signal; prefer correcting/replacing stale entries over piling on duplicates.
- The wiki is your curated knowledge base of WHAT is in this vault (memory = how the vault works; wiki = what's in it). To recall curated knowledge, start at the wiki Home page (wiki_home) and follow its [[links]] toward the topic with wiki_page, reading pages as you go — never dump the whole wiki into context. list_wiki is the sitemap: use it for maintenance and before creating pages, not as the default way in.
- Choose the right retrieval tool: a known, structured topic → wiki_home, then follow links; fuzzy recall ("somewhere there's something about…") → semantic_search (when available), then read the note or wiki page it surfaces; an exact phrase or filename → search.
- When you learn or synthesise something worth keeping, save it to the wiki: extend an existing page (update_wiki with mode "append") when one fits, otherwise create a new page — and always link a new page into the Home page and its related pages so nothing is orphaned.
- Curate the wiki as it grows: fix the orphan pages and broken [[links]] that list_wiki reports, split pages that have grown too big, and merge duplicates.
- Connect wiki notes to each other and to the user's existing notes and past conversations using [[wikilinks]]. Use the links tool to discover how a note already connects before linking.
- Prefer searching and reading the vault before answering, so your responses are grounded in the user's actual notes.
- Be concise and direct. Do the work; don't narrate every step.`;

/**
 * Defaults we previously shipped. When a saved systemPrompt matches one of
 * these verbatim (i.e. the user never customised it), loadSettings upgrades it
 * to the current DEFAULT_SYSTEM_PROMPT.
 */
export const LEGACY_SYSTEM_PROMPTS: string[] = [
	`You are an AI assistant embedded inside the user's Obsidian vault. You can read, search, and (only within permitted folders) write notes using the provided tools, the same way a coding agent works inside a code repository.

Guidelines:
- Treat the user's personal notes as READ-ONLY context. Never modify a note unless the user explicitly asks you to edit that specific file, and only if it is in a writable folder.
- Your "Operating memory" (shown below, if present) is what you already know about how THIS vault is organised — where data lives, the formats and conventions the user uses, and corrections they have given you. Trust it and act on it before exploring. When you learn a durable fact like this, or the user corrects you (e.g. "habits are tracked here now, not there"), save it with the remember tool so you don't relearn it next time. Keep that memory short and high-signal; prefer correcting/replacing stale entries over piling on duplicates.
- When you learn or synthesise something worth keeping, save it to the wiki. First call list_wiki to see what already exists, then either extend an existing page (update_wiki with mode "append") or add a new one, so the wiki grows coherently instead of duplicating pages. (Memory = how the vault works; wiki = what's in it.)
- Connect wiki notes to each other and to the user's existing notes and past conversations using [[wikilinks]]. Use the links tool to discover how a note already connects before linking.
- Prefer searching and reading the vault before answering, so your responses are grounded in the user's actual notes.
- Be concise and direct. Do the work; don't narrate every step.`,
];

export const DEFAULT_SETTINGS: VaultAssistantSettings = {
	baseUrl: 'http://localhost:11434/v1',
	apiKey: '',
	model: 'llama3.1',
	temperature: 0.7,
	maxSteps: 12,
	useExtraBodyParams: false,
	extraBodyParams: '{\n  "dynatemp_range": 0.4,\n  "dynatemp_exponent": 1.0\n}',
	streamResponses: true,
	expandThinking: true,
	systemPrompt: DEFAULT_SYSTEM_PROMPT,
	usePrePass: false,
	useOpenFiles: true,
	readBlockPaths: [],
	writePaths: [],
	conversationsFolder: 'AI/Conversations',
	wikiFolder: 'AI/Wiki',
	autoSaveConversations: true,
	nameConversations: true,
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

/** Parse a textarea of newline/comma-separated folders into a clean list. */
function parseFolders(value: string): string[] {
	return value
		.split(/[\n,]/)
		.map((s) => s.trim())
		.filter(Boolean);
}

export class VaultAssistantSettingTab extends PluginSettingTab {
	plugin: VaultAssistantPlugin;

	constructor(app: App, plugin: VaultAssistantPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	private save = async () => {
		await this.plugin.saveSettings();
	};

	/** Models each endpoint advertised, kept for as long as this tab lives. */
	private discovered = new Map<string, string[]>();
	/** Why an endpoint has no list to offer ('' once it has one). */
	private discoveryState = new Map<string, string>();
	/** Endpoints with a request in flight, so a redraw doesn't fire another. */
	private discovering = new Set<string>();
	/** The live redraw for each picker, so a finished lookup can refresh it. */
	private pickers = new Map<PickerKind, () => void>();

	/**
	 * Offer the models an endpoint advertises, as a dropdown once there is more
	 * than one. Discovery runs when the settings tab is opened; editing the URL
	 * doesn't re-run it (that would fire a request per keystroke), so the
	 * refresh button next to the field is the way to look again.
	 */
	private renderModelPicker(
		container: HTMLElement,
		kind: PickerKind,
		opts: {
			endpoint: () => { url: string; key: string };
			current: () => string;
			apply: (id: string) => Promise<void>;
		},
	): void {
		const render = (): void => {
			container.empty();
			const { url: configured, key } = opts.endpoint();
			const url = canonicalUrl(configured);
			if (!url) return;

			if (!this.discovered.has(url) && !this.discoveryState.has(url)) {
				this.discover(url, key);
			}

			const models = filterModels(this.discovered.get(url) ?? [], kind);
			const current = opts.current();

			if (models.length > 1) {
				new Setting(container)
					.setName(kind === 'chat' ? 'Available models' : 'Available embedding models')
					.setDesc(`${models.length} models detected at ${url}.`)
					.addDropdown((d) => {
						// Keep a hand-typed name selectable, so picking from the
						// list is never a one-way door.
						if (!models.includes(current)) {
							d.addOption(current, current ? `${current} (typed)` : '(not set)');
						}
						for (const id of models) d.addOption(id, modelLabel(id));
						d.setValue(current).onChange(async (v) => {
							await opts.apply(v);
							render();
						});
					});
			} else if (models.length === 1) {
				const only = models[0] ?? '';
				const row = new Setting(container)
					.setName(kind === 'chat' ? 'Available model' : 'Available embedding model')
					.setDesc(`The endpoint serves one model: ${only}`);
				if (only !== current) {
					row.addButton((b) =>
						b.setButtonText('Use it').onClick(async () => {
							await opts.apply(only);
							render();
						}),
					);
				}
			}

			const state = this.discoveryState.get(url);
			if (state) container.createDiv({ cls: 'va-rag-status', text: state });
		};

		this.pickers.set(kind, render);
		render();
	}

	/**
	 * Look up one endpoint's models, then redraw the pickers. Both pickers are
	 * redrawn because they often share an endpoint — the embeddings fields
	 * default to the chat endpoint — and one lookup answers for both.
	 */
	private discover(url: string, key: string): void {
		if (this.discovering.has(url)) return;
		this.discovering.add(url);
		this.discoveryState.set(url, 'Looking for available models…');
		void listModels(url, key)
			.then((ids) => {
				this.discovered.set(url, ids);
				this.discoveryState.set(
					url,
					ids.length ? '' : 'The endpoint reported no models — type the name instead.',
				);
			})
			.catch((e: unknown) => {
				this.discoveryState.set(
					url,
					`Could not list models: ${e instanceof Error ? e.message : String(e)}. Type the name instead.`,
				);
			})
			.finally(() => {
				this.discovering.delete(url);
				this.redrawPickers();
			});
	}

	/** Forget what an endpoint said and ask it again (the refresh button). */
	private rediscover(configured: string): void {
		const url = canonicalUrl(configured);
		this.discovered.delete(url);
		this.discoveryState.delete(url);
		this.redrawPickers();
	}

	private redrawPickers(): void {
		for (const render of this.pickers.values()) render();
	}

	display(): void {
		const { containerEl } = this;
		const s = this.plugin.settings;
		containerEl.empty();
		// Every picker below is rebuilt; drop the previous redraws with their
		// now-detached containers.
		this.pickers.clear();

		new Setting(containerEl).setName('Model endpoint').setHeading();

		new Setting(containerEl)
			.setName('Base URL')
			.setDesc(
				'OpenAI-compatible base URL. Examples: http://localhost:11434/v1 (Ollama), http://localhost:1234/v1 (LM Studio), https://api.openai.com/v1.',
			)
			.addText((t) =>
				t
					.setPlaceholder('http://localhost:11434/v1')
					.setValue(s.baseUrl)
					.onChange(async (v) => {
						s.baseUrl = v.trim();
						await this.save();
					}),
			);

		new Setting(containerEl)
			.setName('API key')
			.setDesc('Optional. Leave empty for local models that do not need one.')
			.addText((t) => {
				t.inputEl.type = 'password';
				t.setPlaceholder('sk-...')
					.setValue(s.apiKey)
					.onChange(async (v) => {
						s.apiKey = v.trim();
						await this.save();
					});
			});

		let modelText: TextComponent | null = null;
		new Setting(containerEl)
			.setName('Model')
			.setDesc('Model name as your endpoint expects it. Detected models are offered below.')
			.addText((t) => {
				modelText = t;
				t.setPlaceholder('llama3.1')
					.setValue(s.model)
					.onChange(async (v) => {
						s.model = v.trim();
						await this.save();
					});
			})
			.addExtraButton((b) =>
				b
					.setIcon('refresh-cw')
					.setTooltip('Detect models from the endpoint')
					.onClick(() => this.rediscover(s.baseUrl)),
			);

		this.renderModelPicker(containerEl.createDiv(), 'chat', {
			endpoint: () => ({ url: s.baseUrl, key: s.apiKey }),
			current: () => s.model,
			apply: async (id) => {
				s.model = id;
				modelText?.setValue(id);
				await this.save();
			},
		});

		new Setting(containerEl)
			.setName('Temperature')
			.setDesc('Sampling temperature (0–2).')
			.addText((t) =>
				t.setValue(String(s.temperature)).onChange(async (v) => {
					const n = Number(v);
					if (!Number.isNaN(n)) {
						s.temperature = n;
						await this.save();
					}
				}),
			);

		new Setting(containerEl)
			.setName('Max tool steps')
			.setDesc('Maximum tool-call rounds per message before the agent must answer.')
			.addText((t) =>
				t.setValue(String(s.maxSteps)).onChange(async (v) => {
					const n = parseInt(v, 10);
					if (!Number.isNaN(n) && n > 0) {
						s.maxSteps = n;
						await this.save();
					}
				}),
			);

		new Setting(containerEl)
			.setName('Stream responses')
			.setDesc(
				'Show the answer as it is written, and let you stop it mid-answer with the Stop button or Ctrl+C. Turn this off if your endpoint cannot stream — the plugin also falls back to a single request automatically when a stream cannot be opened.',
			)
			.addToggle((t) =>
				t.setValue(s.streamResponses).onChange(async (v) => {
					s.streamResponses = v;
					await this.save();
					this.display();
				}),
			);

		if (s.streamResponses) {
			new Setting(containerEl)
				.setName('Show thinking as it happens')
				.setDesc(
					'Keep the thinking section expanded while a reasoning model works, then collapse it to "Thought for Ns" once the answer starts. Turn this off to keep it collapsed from the start. Either way you can open it anytime.',
				)
				.addToggle((t) =>
					t.setValue(s.expandThinking).onChange(async (v) => {
						s.expandThinking = v;
						await this.save();
					}),
				);
		}

		new Setting(containerEl)
			.setName('Prepare context before answering')
			.setDesc(
				'Before each of your messages, make one cheap model call to turn it into a few search queries, run them against the vault (semantic search when enabled, literal otherwise), and inject the top hits into the system prompt. Helps small local models ground their answers with fewer tool rounds, at the cost of one extra round-trip.',
			)
			.addToggle((t) =>
				t.setValue(s.usePrePass).onChange(async (v) => {
					s.usePrePass = v;
					await this.save();
				}),
			);

		new Setting(containerEl)
			.setName('Send extra request parameters')
			.setDesc(
				'Merge the JSON object below into every chat request. Lets you enable server-side samplers your endpoint supports — e.g. llama.cpp’s dynamic temperature (dynatemp_range) or mirostat. Ollama’s OpenAI-compatible route ignores these.',
			)
			.addToggle((t) =>
				t.setValue(s.useExtraBodyParams).onChange(async (v) => {
					s.useExtraBodyParams = v;
					await this.save();
					this.display();
				}),
			);

		if (s.useExtraBodyParams) {
			const paramsErr = containerEl.createDiv({ cls: 'va-settings-error' });
			new Setting(containerEl)
				.setName('Extra parameters (JSON object)')
				.setDesc(
					'Sent as top-level request-body fields. Cannot override model, messages, or tools.',
				)
				.addTextArea((t) => {
					t.inputEl.rows = 5;
					t.inputEl.addClass('va-wide-textarea');
					t.setValue(s.extraBodyParams).onChange(async (v) => {
						paramsErr.setText('');
						s.extraBodyParams = v;
						if (v.trim()) {
							try {
								const parsed: unknown = JSON.parse(v);
								if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
									throw new Error('Expected a JSON object.');
								}
							} catch (e) {
								paramsErr.setText(
									`Invalid JSON (will be ignored): ${e instanceof Error ? e.message : String(e)}`,
								);
							}
						}
						await this.save();
					});
				});
		}

		new Setting(containerEl).setName('Folder permissions').setHeading();

		new Setting(containerEl)
			.setName('Blocked folders (reads)')
			.setDesc(
				'One folder per line. The agent can read your whole vault except these. Blocked notes are hidden from it entirely — not listed, not searchable, and invisible to reads. e.g. "Private", "Journal".',
			)
			.addTextArea((t) => {
				t.inputEl.rows = 4;
				t.setValue(s.readBlockPaths.join('\n')).onChange(async (v) => {
					s.readBlockPaths = parseFolders(v);
					await this.save();
				});
			});

		new Setting(containerEl)
			.setName('Writable folders')
			.setDesc(
				'One folder per line. The agent may write freely inside these (the conversations and wiki folders are always writable). Writing anywhere else pauses and asks you for approval. Leave empty to be asked before every write outside the AI folders.',
			)
			.addTextArea((t) => {
				t.inputEl.rows = 4;
				t.setValue(s.writePaths.join('\n')).onChange(async (v) => {
					s.writePaths = parseFolders(v);
					await this.save();
				});
			});

		new Setting(containerEl)
			.setName('Conversations folder')
			.setDesc('Where chat transcripts are saved. Always writable.')
			.addText((t) =>
				t
					.setPlaceholder('AI/Conversations')
					.setValue(s.conversationsFolder)
					.onChange(async (v) => {
						s.conversationsFolder = v.trim();
						await this.save();
					}),
			);

		new Setting(containerEl)
			.setName('Wiki folder')
			.setDesc('Where the generated, interlinked wiki lives. Always writable.')
			.addText((t) =>
				t
					.setPlaceholder('AI/Wiki')
					.setValue(s.wikiFolder)
					.onChange(async (v) => {
						s.wikiFolder = v.trim();
						await this.save();
					}),
			);

		new Setting(containerEl)
			.setName('Auto-save conversations')
			.setDesc('Save each conversation to the conversations folder as you chat.')
			.addToggle((t) =>
				t.setValue(s.autoSaveConversations).onChange(async (v) => {
					s.autoSaveConversations = v;
					await this.save();
					this.display();
				}),
			);

		if (s.autoSaveConversations) {
			new Setting(containerEl)
				.setName('Let the model name conversations')
				.setDesc(
					'After the first exchange, make one cheap model call to title the conversation, and save it as "2026-08-12 1432 Reworking the RAG chunker". Turn this off to name files after your first message instead, with no extra call.',
				)
				.addToggle((t) =>
					t.setValue(s.nameConversations).onChange(async (v) => {
						s.nameConversations = v;
						await this.save();
					}),
				);
		}

		new Setting(containerEl)
			.setName('See what you have open')
			.setDesc(
				'Let the agent see which notes are open in Obsidian and which one is focused, so "summarise this note" or "what am I looking at" work without naming a file. The list is refreshed before each of your messages, and the agent can re-check it with the open_files tool. Notes in blocked folders are never listed.',
			)
			.addToggle((t) =>
				t.setValue(s.useOpenFiles).onChange(async (v) => {
					s.useOpenFiles = v;
					await this.save();
				}),
			);

		new Setting(containerEl).setName('Operating memory').setHeading();

		new Setting(containerEl)
			.setName('Use operating memory')
			.setDesc(
				'Inject a small, curated memory file into the agent at the start of every conversation, and let it record durable facts (where data lives, your formats, corrections) with the remember tool. This is how it avoids relearning your vault each time.',
			)
			.addToggle((t) =>
				t.setValue(s.useMemory).onChange(async (v) => {
					s.useMemory = v;
					await this.save();
					this.display();
				}),
			);

		if (s.useMemory) {
			new Setting(containerEl)
				.setName('Memory file')
				.setDesc(
					'Path to the operating-memory note. Always readable and writable. Loaded in full each session, so keep it concise.',
				)
				.addText((t) =>
					t
						.setPlaceholder('AI/Memory.md')
						.setValue(s.memoryFile)
						.onChange(async (v) => {
							s.memoryFile = v.trim();
							await this.save();
						}),
				);
		}

		new Setting(containerEl).setName('Wiki').setHeading();

		new Setting(containerEl)
			.setName('Home page title')
			.setDesc(
				'Title of the curated entry page inside the wiki folder — the table of contents the agent starts from and links new pages into.',
			)
			.addText((t) =>
				t
					.setPlaceholder('Home')
					.setValue(s.wikiHomeNote)
					.onChange(async (v) => {
						s.wikiHomeNote = v.trim();
						await this.save();
					}),
			);

		new Setting(containerEl)
			.setName('Show wiki index at session start')
			.setDesc(
				'Inject a compact pointer to the wiki Home page into each new conversation, so the agent knows what curated knowledge exists without loading the whole wiki.',
			)
			.addToggle((t) =>
				t.setValue(s.useWikiIndex).onChange(async (v) => {
					s.useWikiIndex = v;
					await this.save();
				}),
			);

		new Setting(containerEl).setName('Workflows').setHeading();

		new Setting(containerEl)
			.setName('Runs folder')
			.setDesc(
				'Where workflow-run notes (the goal plus each round’s report) are saved. Always writable.',
			)
			.addText((t) =>
				t
					.setPlaceholder('AI/Research')
					.setValue(s.researchFolder)
					.onChange(async (v) => {
						s.researchFolder = v.trim();
						await this.save();
					}),
			);

		new Setting(containerEl)
			.setName('Workflows folder')
			.setDesc(
				'Where workflow definition notes live. Notes here (with "steps" in frontmatter) appear in the workflow picker alongside the built-in presets. Always writable.',
			)
			.addText((t) =>
				t
					.setPlaceholder('AI/Workflows')
					.setValue(s.workflowsFolder)
					.onChange(async (v) => {
						s.workflowsFolder = v.trim();
						await this.save();
					}),
			);

		new Setting(containerEl)
			.setName('Default rounds per run')
			.setDesc('Rounds budget suggested when starting a run. 0 = run until stopped.')
			.addText((t) =>
				t.setValue(String(s.researchDefaultRounds)).onChange(async (v) => {
					const n = parseInt(v, 10);
					if (!Number.isNaN(n) && n >= 0) {
						s.researchDefaultRounds = n;
						await this.save();
					}
				}),
			);

		new Setting(containerEl)
			.setName('Default delay between rounds')
			.setDesc('Seconds to pause between rounds, suggested when starting a run.')
			.addText((t) =>
				t.setValue(String(s.researchDefaultDelaySeconds)).onChange(async (v) => {
					const n = parseInt(v, 10);
					if (!Number.isNaN(n) && n >= 0) {
						s.researchDefaultDelaySeconds = n;
						await this.save();
					}
				}),
			);

		new Setting(containerEl)
			.setName('Goals note')
			.setDesc(
				'The note workflows reference via {{goalsFile}} — the life coach reads it to know what you are working toward. Always readable and writable.',
			)
			.addText((t) =>
				t
					.setPlaceholder('AI/Goals.md')
					.setValue(s.goalsFile)
					.onChange(async (v) => {
						s.goalsFile = v.trim();
						await this.save();
					}),
			);

		new Setting(containerEl).setName('Scheduled runs').setHeading();

		new Setting(containerEl)
			.setName('Run a workflow on a schedule')
			.setDesc(
				'While Obsidian is open, run the chosen workflow headlessly every N hours (one round per run), with a catch-up run shortly after startup when one was missed. Reports accumulate in a run note; you will get a notice when each run finishes. The model endpoint is called unattended — with a local model this is free; on a paid API, mind the cost.',
			)
			.addToggle((t) =>
				t.setValue(s.scheduleEnabled).onChange(async (v) => {
					s.scheduleEnabled = v;
					await this.save();
					this.display();
				}),
			);

		if (s.scheduleEnabled) {
			new Setting(containerEl).setName('Workflow to run').addDropdown((d) => {
				const { workflows } = loadWorkflows(this.app, s, WORKFLOW_PRESETS);
				for (const w of workflows) d.addOption(w.id, w.name);
				if (!workflows.some((w) => w.id === s.scheduleWorkflowId)) {
					d.addOption(s.scheduleWorkflowId, `${s.scheduleWorkflowId} (missing)`);
				}
				d.setValue(s.scheduleWorkflowId).onChange(async (v) => {
					s.scheduleWorkflowId = v;
					await this.save();
				});
			});

			new Setting(containerEl)
				.setName('Every (hours)')
				.setDesc('24 = once a day.')
				.addText((t) =>
					t.setValue(String(s.scheduleEveryHours)).onChange(async (v) => {
						const n = Number(v);
						if (!Number.isNaN(n) && n >= 1) {
							s.scheduleEveryHours = n;
							await this.save();
						}
					}),
				);

			new Setting(containerEl)
				.setName('Goal for scheduled runs')
				.setDesc('Used when a scheduled run starts a fresh run note. {{goalsFile}} expands to your goals note path.')
				.addTextArea((t) => {
					t.inputEl.rows = 3;
					t.inputEl.addClass('va-wide-textarea');
					t.setValue(s.scheduleGoal).onChange(async (v) => {
						s.scheduleGoal = v;
						await this.save();
					});
				});

			if (s.lastScheduledOutcome) {
				containerEl.createDiv({
					cls: 'va-rag-status',
					text: `Last scheduled run: ${s.lastScheduledOutcome}`,
				});
			}
		}

		new Setting(containerEl).setName('Semantic search').setHeading();

		new Setting(containerEl)
			.setName('Enable semantic search')
			.setDesc(
				'Index the vault with an embedding model and give the agent a semantic_search tool. Note contents are sent to the embedding endpoint — use a local model (Ollama/LM Studio) to stay offline.',
			)
			.addToggle((t) =>
				t.setValue(s.useRag).onChange(async (v) => {
					s.useRag = v;
					await this.save();
					this.display();
				}),
			);

		if (s.useRag) {
			let embedText: TextComponent | null = null;
			new Setting(containerEl)
				.setName('Embedding model')
				.setDesc('e.g. nomic-embed-text (Ollama) or text-embedding-3-small (OpenAI).')
				.addText((t) => {
					embedText = t;
					t.setPlaceholder('nomic-embed-text')
						.setValue(s.embedModel)
						.onChange(async (v) => {
							s.embedModel = v.trim();
							await this.save();
						});
				})
				.addExtraButton((b) =>
					b
						.setIcon('refresh-cw')
						.setTooltip('Detect models from the embeddings endpoint')
						.onClick(() => this.rediscover(s.embedBaseUrl || s.baseUrl)),
				);

			this.renderModelPicker(containerEl.createDiv(), 'embed', {
				endpoint: () => ({
					url: s.embedBaseUrl || s.baseUrl,
					key: s.embedApiKey || s.apiKey,
				}),
				current: () => s.embedModel,
				apply: async (id) => {
					s.embedModel = id;
					embedText?.setValue(id);
					await this.save();
				},
			});

			new Setting(containerEl)
				.setName('Embedding base URL')
				.setDesc('Optional. Leave empty to use the chat base URL.')
				.addText((t) =>
					t
						.setPlaceholder('(chat base URL)')
						.setValue(s.embedBaseUrl)
						.onChange(async (v) => {
							s.embedBaseUrl = v.trim();
							await this.save();
						}),
				);

			new Setting(containerEl)
				.setName('Embedding API key')
				.setDesc('Optional. Leave empty to use the chat API key.')
				.addText((t) => {
					t.inputEl.type = 'password';
					t.setPlaceholder('(chat API key)')
						.setValue(s.embedApiKey)
						.onChange(async (v) => {
							s.embedApiKey = v.trim();
							await this.save();
						});
				});

			new Setting(containerEl)
				.setName('Results per search')
				.setDesc('How many chunks semantic_search returns by default.')
				.addText((t) =>
					t.setValue(String(s.ragTopK)).onChange(async (v) => {
						const n = parseInt(v, 10);
						if (!Number.isNaN(n) && n > 0) {
							s.ragTopK = n;
							await this.save();
						}
					}),
				);

			new Setting(containerEl)
				.setName('Index wiki pages')
				.setDesc('Also embed the wiki, so semantic search can land directly on curated pages.')
				.addToggle((t) =>
					t.setValue(s.ragIndexWiki).onChange(async (v) => {
						s.ragIndexWiki = v;
						await this.save();
					}),
				);

			new Setting(containerEl)
				.setName('Index conversations')
				.setDesc(
					'Also embed saved conversations, filtered to your messages and the agent’s final answers (tool calls and intermediate steps are dropped).',
				)
				.addToggle((t) =>
					t.setValue(s.ragIndexConversations).onChange(async (v) => {
						s.ragIndexConversations = v;
						await this.save();
					}),
				);

			const status = containerEl.createDiv({ cls: 'va-rag-status' });
			const showStatus = (text: string) => status.setText(text);
			void this.plugin.rag
				.status()
				.then((st) =>
					showStatus(
						st.chunks
							? `${st.chunks} chunks from ${st.files} files` +
									(st.lastIndexed
										? ` · last indexed ${new Date(st.lastIndexed).toLocaleString()}`
										: '')
							: 'Not indexed yet.',
					),
				);

			new Setting(containerEl)
				.setName('Reindex now')
				.setDesc('Rebuild the semantic index. Unchanged chunks are not re-embedded.')
				.addButton((b) =>
					b.setButtonText('Reindex').onClick(async () => {
						b.setDisabled(true);
						try {
							const res = await this.plugin.rag.reindexAll((done, total) =>
								showStatus(`Indexing… ${done}/${total} files`),
							);
							showStatus(`${res.chunks} chunks from ${res.files} files · just indexed`);
						} catch (e) {
							showStatus(`Indexing failed: ${e instanceof Error ? e.message : String(e)}`);
						} finally {
							b.setDisabled(false);
						}
					}),
				);
		}

		new Setting(containerEl).setName('MCP servers').setHeading();

		const err = containerEl.createDiv({ cls: 'va-settings-error' });

		new Setting(containerEl)
			.setName('Server definitions')
			.setDesc(
				'JSON array of MCP servers. Each: {"id","name","enabled":true,"trusted":false,"transport":"stdio","command":"npx","args":[...],"env":{}}, {"transport":"http","url":"https://…","headers":{}}, or {"transport":"plugin","pluginId":"obsidian-life-tracker"} (another installed plugin’s tool api, called in-process — works on mobile). stdio servers run only on desktop. Trusted servers’ tools run without an approval prompt.',
			)
			.addTextArea((t) => {
				t.inputEl.rows = 8;
				t.inputEl.addClass('va-wide-textarea');
				t.setValue(JSON.stringify(s.mcpServers, null, 2)).onChange(async (v) => {
					err.setText('');
					if (!v.trim()) {
						s.mcpServers = [];
						await this.save();
						return;
					}
					try {
						const parsed: unknown = JSON.parse(v);
						if (!Array.isArray(parsed)) throw new Error('Expected a JSON array.');
						s.mcpServers = parsed as VaultAssistantSettings['mcpServers'];
						await this.save();
					} catch (e) {
						err.setText(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
					}
				});
			});

		new Setting(containerEl)
			.setName('Reconnect servers')
			.setDesc('Apply server changes by reconnecting now.')
			.addButton((b) =>
				b.setButtonText('Reconnect').onClick(async () => {
					await this.plugin.reconnectMcp();
				}),
			);

		new Setting(containerEl).setName('Agent prompt').setHeading();

		new Setting(containerEl)
			.setName('System prompt')
			.setDesc(
				'Base instructions for the agent. Current folders and permissions are appended automatically.',
			)
			.addTextArea((t) => {
				t.inputEl.rows = 8;
				t.inputEl.addClass('va-wide-textarea');
				t.setValue(s.systemPrompt).onChange(async (v) => {
					s.systemPrompt = v;
					await this.save();
				});
			});
	}
}
