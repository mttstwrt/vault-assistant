import { App, FuzzySuggestModal, TFile, normalizePath } from 'obsidian';

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
