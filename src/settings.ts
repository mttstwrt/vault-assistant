import { App, PluginSettingTab, Setting } from 'obsidian';
import type AIVaultChatPlugin from './main';

export interface AIChatSettings {
	// --- Model endpoint ---
	baseUrl: string;
	apiKey: string;
	model: string;
	temperature: number;
	maxSteps: number;

	// --- Agent behaviour ---
	systemPrompt: string;

	// --- Folder permissions ---
	readScope: 'vault' | 'allowlist';
	readPaths: string[];
	writePaths: string[];
	conversationsFolder: string;
	wikiFolder: string;
	autoSaveConversations: boolean;
}

export const DEFAULT_SYSTEM_PROMPT = `You are an AI assistant embedded inside the user's Obsidian vault. You can read, search, and (only within permitted folders) write notes using the provided tools, the same way a coding agent works inside a code repository.

Guidelines:
- Treat the user's personal notes as READ-ONLY context. Never modify a note unless the user explicitly asks you to edit that specific file, and only if it is in a writable folder.
- When you learn or synthesise something worth keeping, save it to the wiki. First call list_wiki to see what already exists, then either extend an existing page (update_wiki with mode "append") or add a new one, so the wiki grows coherently instead of duplicating pages.
- Connect wiki notes to each other and to the user's existing notes and past conversations using [[wikilinks]]. Use the links tool to discover how a note already connects before linking.
- Prefer searching and reading the vault before answering, so your responses are grounded in the user's actual notes.
- Be concise and direct. Do the work; don't narrate every step.`;

export const DEFAULT_SETTINGS: AIChatSettings = {
	baseUrl: 'http://localhost:11434/v1',
	apiKey: '',
	model: 'llama3.1',
	temperature: 0.7,
	maxSteps: 12,
	systemPrompt: DEFAULT_SYSTEM_PROMPT,
	readScope: 'vault',
	readPaths: [],
	writePaths: [],
	conversationsFolder: 'AI/Conversations',
	wikiFolder: 'AI/Wiki',
	autoSaveConversations: true,
};

/** Parse a textarea of newline/comma-separated folders into a clean list. */
function parseFolders(value: string): string[] {
	return value
		.split(/[\n,]/)
		.map((s) => s.trim())
		.filter(Boolean);
}

export class AIChatSettingTab extends PluginSettingTab {
	plugin: AIVaultChatPlugin;

	constructor(app: App, plugin: AIVaultChatPlugin) {
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
			.setName('Read scope')
			.setDesc('Whether the agent can read the whole vault or only an allowlist of folders.')
			.addDropdown((d) =>
				d
					.addOption('vault', 'Entire vault')
					.addOption('allowlist', 'Only allowed folders')
					.setValue(s.readScope)
					.onChange(async (v) => {
						s.readScope = v as AIChatSettings['readScope'];
						await this.save();
						this.display();
					}),
			);

		if (s.readScope === 'allowlist') {
			new Setting(containerEl)
				.setName('Readable folders')
				.setDesc(
					'One folder per line. The agent can only read inside these (plus the conversations and wiki folders). e.g. "Daily Notes".',
				)
				.addTextArea((t) => {
					t.inputEl.rows = 4;
					t.setValue(s.readPaths.join('\n')).onChange(async (v) => {
						s.readPaths = parseFolders(v);
						await this.save();
					});
				});
		}

		new Setting(containerEl)
			.setName('Writable folders')
			.setDesc(
				'One folder per line. The agent may only create or edit files inside these (the conversations and wiki folders are always writable). Leave empty to keep all your own notes untouched.',
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

		new Setting(containerEl).setName('Agent prompt').setHeading();

		new Setting(containerEl)
			.setName('System prompt')
			.setDesc(
				'Base instructions for the agent. Current folders and permissions are appended automatically.',
			)
			.addTextArea((t) => {
				t.inputEl.rows = 8;
				t.inputEl.addClass('avc-wide-textarea');
				t.setValue(s.systemPrompt).onChange(async (v) => {
					s.systemPrompt = v;
					await this.save();
				});
			});
	}
}
