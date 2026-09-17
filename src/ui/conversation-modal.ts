import { App, SuggestModal, TFile, normalizePath } from 'obsidian';

/** How many transcripts to offer when nothing has been typed yet. */
const RECENT = 40;
/** Files whose text a query may be searched through, newest first. */
const SEARCHABLE = 300;
/** Characters of a matching line to show either side of the hit. */
const SNIPPET_PAD = 60;
/** Below this, a query is too short for a content scan to mean anything. */
const MIN_CONTENT_QUERY = 3;

interface Hit {
	file: TFile;
	/** The line the query was found on, when it was found in the text. */
	snippet: string;
}

/**
 * Pick a saved conversation, by name or by something said in it.
 *
 * Searching the text matters more here than in most pickers: transcripts are
 * named after their topic by a model, so the thing you remember is usually a
 * phrase from inside one rather than the title somebody else chose. A filename
 * match wins over a content match — if you know the name, you meant the name —
 * and the text is only read once a query is long enough to be worth scanning
 * for, so opening the picker stays instant.
 */
export class ConversationPicker extends SuggestModal<Hit> {
	private folder: string;
	private onPick: (file: TFile) => void;
	/** Transcripts already read this session, so repeated keystrokes are free. */
	private text = new Map<string, string>();

	constructor(app: App, conversationsFolder: string, onPick: (file: TFile) => void) {
		super(app);
		this.folder = normalizePath(conversationsFolder);
		this.onPick = onPick;
		this.setPlaceholder('Search your conversations by name or by what was said…');
	}

	private conversations(): TFile[] {
		const prefix = this.folder ? `${this.folder}/` : '';
		return this.app.vault
			.getMarkdownFiles()
			.filter((f) => f.path.startsWith(prefix))
			.sort((a, b) => b.stat.mtime - a.stat.mtime);
	}

	/** The transcript's name without its folder or extension. */
	private title(file: TFile): string {
		const prefix = this.folder ? `${this.folder}/` : '';
		return file.path.slice(prefix.length).replace(/\.md$/, '');
	}

	async getSuggestions(query: string): Promise<Hit[]> {
		const files = this.conversations();
		const q = query.trim().toLowerCase();
		if (!q) return files.slice(0, RECENT).map((file) => ({ file, snippet: '' }));

		const byName: Hit[] = [];
		const rest: TFile[] = [];
		for (const file of files) {
			if (this.title(file).toLowerCase().includes(q)) byName.push({ file, snippet: '' });
			else rest.push(file);
		}
		if (q.length < MIN_CONTENT_QUERY) return byName;

		const byContent: Hit[] = [];
		for (const file of rest.slice(0, SEARCHABLE)) {
			const snippet = await this.findInText(file, q);
			if (snippet) byContent.push({ file, snippet });
		}
		return [...byName, ...byContent];
	}

	/** The first line of `file` carrying `q`, trimmed to something readable. */
	private async findInText(file: TFile, q: string): Promise<string> {
		let body = this.text.get(file.path);
		if (body === undefined) {
			body = await this.app.vault.cachedRead(file);
			this.text.set(file.path, body);
		}
		const at = body.toLowerCase().indexOf(q);
		if (at === -1) return '';

		// Stay within the line the hit is on: a transcript is full of fenced
		// blocks, and spilling across them reads as nonsense.
		const from = body.lastIndexOf('\n', at) + 1;
		const to = body.indexOf('\n', at);
		const line = body.slice(from, to === -1 ? body.length : to).trim();
		const within = line.toLowerCase().indexOf(q);
		const start = Math.max(0, within - SNIPPET_PAD);
		const end = Math.min(line.length, within + q.length + SNIPPET_PAD);
		return `${start ? '…' : ''}${line.slice(start, end)}${end < line.length ? '…' : ''}`;
	}

	renderSuggestion(hit: Hit, el: HTMLElement): void {
		el.createDiv({ text: this.title(hit.file) });
		if (hit.snippet) el.createDiv({ cls: 'va-import-meta', text: hit.snippet });
	}

	onChooseSuggestion(hit: Hit): void {
		this.onPick(hit.file);
	}
}
