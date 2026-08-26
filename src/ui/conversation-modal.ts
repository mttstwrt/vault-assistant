import { App, FuzzySuggestModal, Modal, TFile, normalizePath } from 'obsidian';

/** Fuzzy picker over saved conversation transcripts, newest first. */
export class ConversationPicker extends FuzzySuggestModal<TFile> {
	private folder: string;
	private onPick: (file: TFile) => void;

	constructor(app: App, conversationsFolder: string, onPick: (file: TFile) => void) {
		super(app);
		this.folder = normalizePath(conversationsFolder);
		this.onPick = onPick;
		this.setPlaceholder('Open a previous conversation…');
	}

	getItems(): TFile[] {
		const prefix = this.folder ? `${this.folder}/` : '';
		return this.app.vault
			.getMarkdownFiles()
			.filter((f) => f.path.startsWith(prefix))
			.sort((a, b) => b.stat.mtime - a.stat.mtime);
	}

	getItemText(file: TFile): string {
		const prefix = this.folder ? `${this.folder}/` : '';
		return file.path.slice(prefix.length).replace(/\.md$/, '');
	}

	onChooseItem(file: TFile): void {
		this.onPick(file);
	}
}

/** What the user chose when asked about a conversation that isn't on disk. */
export type UnsavedChoice = 'save' | 'discard' | 'cancel';

interface UnsavedPrompt {
	title: string;
	body: string;
	/** Label for the button that saves first, e.g. "Save". */
	saveLabel: string;
	/** Label for the button that goes ahead anyway, e.g. "Discard". */
	discardLabel: string;
}

/**
 * Ask before something would take a conversation with it. Conversations are
 * not written to the vault until asked for, so the panel is the only copy —
 * and closing over one is the one moment where it can be lost for good.
 */
class UnsavedChatModal extends Modal {
	private chosen: UnsavedChoice | null = null;

	constructor(
		app: App,
		private prompt: UnsavedPrompt,
		private onChoose: (choice: UnsavedChoice) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(this.prompt.title);
		this.contentEl.createEl('p', { text: this.prompt.body });

		const row = this.contentEl.createDiv({ cls: 'va-modal-buttons' });
		const choose = (choice: UnsavedChoice): void => {
			this.chosen = choice;
			this.close();
		};

		const save = row.createEl('button', { text: this.prompt.saveLabel, cls: 'mod-cta' });
		save.onclick = () => choose('save');
		const discard = row.createEl('button', { text: this.prompt.discardLabel, cls: 'mod-warning' });
		discard.onclick = () => choose('discard');
		const cancel = row.createEl('button', { text: 'Cancel' });
		cancel.onclick = () => choose('cancel');
		save.focus();
	}

	onClose(): void {
		this.contentEl.empty();
		// Escape and the close button both mean "I didn't mean to do that".
		this.onChoose(this.chosen ?? 'cancel');
	}
}

/** Show {@link UnsavedChatModal} and wait for the answer. */
export function askUnsavedChat(app: App, prompt: UnsavedPrompt): Promise<UnsavedChoice> {
	return new Promise((resolve) => new UnsavedChatModal(app, prompt, resolve).open());
}
