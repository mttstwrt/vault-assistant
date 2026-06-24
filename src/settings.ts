import { App, PluginSettingTab, Setting } from 'obsidian';
import type VaultAssistantPlugin from './main';

export interface VaultAssistantSettings {
	// --- Model endpoint ---
	baseUrl: string;
	apiKey: string;
	model: string;
	temperature: number;
	maxSteps: number;

	// --- Agent behaviour ---
	systemPrompt: string;

	// --- Folder permissions ---
	readBlockPaths: string[];
	writePaths: string[];
	conversationsFolder: string;
	wikiFolder: string;
	autoSaveConversations: boolean;

	// --- Operating memory ---
	useMemory: boolean;
	memoryFile: string;
}

export const DEFAULT_SYSTEM_PROMPT = `You are an AI assistant embedded inside the user's Obsidian vault. You can read, search, and (only within permitted folders) write notes using the provided tools, the same way a coding agent works inside a code repository.

Guidelines:
- Treat the user's personal notes as READ-ONLY context. Never modify a note unless the user explicitly asks you to edit that specific file, and only if it is in a writable folder.
- Your "Operating memory" (shown below, if present) is what you already know about how THIS vault is organised — where data lives, the formats and conventions the user uses, and corrections they have given you. Trust it and act on it before exploring. When you learn a durable fact like this, or the user corrects you (e.g. "habits are tracked here now, not there"), save it with the remember tool so you don't relearn it next time. Keep that memory short and high-signal; prefer correcting/replacing stale entries over piling on duplicates.
- When you learn or synthesise something worth keeping, save it to the wiki. First call list_wiki to see what already exists, then either extend an existing page (update_wiki with mode "append") or add a new one, so the wiki grows coherently instead of duplicating pages. (Memory = how the vault works; wiki = what's in it.)
- Connect wiki notes to each other and to the user's existing notes and past conversations using [[wikilinks]]. Use the links tool to discover how a note already connects before linking.
- Prefer searching and reading the vault before answering, so your responses are grounded in the user's actual notes.
- Be concise and direct. Do the work; don't narrate every step.`;

export const DEFAULT_SETTINGS: VaultAssistantSettings = {
	baseUrl: 'http://localhost:11434/v1',
	apiKey: '',
	model: 'llama3.1',
	temperature: 0.7,
	maxSteps: 12,
	systemPrompt: DEFAULT_SYSTEM_PROMPT,
	readBlockPaths: [],
	writePaths: [],
	conversationsFolder: 'AI/Conversations',
	wikiFolder: 'AI/Wiki',
	autoSaveConversations: true,
	useMemory: true,
	memoryFile: 'AI/Memory.md',
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

	display(): void {
		const { containerEl } = this;
		const s = this.plugin.settings;
		containerEl.empty();

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

		new Setting(containerEl)
			.setName('Model')
			.setDesc('Model name as your endpoint expects it.')
			.addText((t) =>
				t
					.setPlaceholder('llama3.1')
					.setValue(s.model)
					.onChange(async (v) => {
						s.model = v.trim();
						await this.save();
					}),
			);

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
