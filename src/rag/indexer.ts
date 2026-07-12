import { App, TFile, debounce, normalizePath } from 'obsidian';
import { VaultAssistantSettings } from '../settings';
import { isReadable } from '../permissions';
import { embed } from '../api/client';
import { inFolder } from '../tools/graph';
import { Chunk, chunkConversation, chunkMarkdown } from './chunk';
import { RagStore, hashText } from './store';

const INDEX_FILE = 'rag-index.json';
/** Chunks embedded per API request. */
const BATCH = 16;

type Source = 'vault' | 'wiki' | 'conversation';

export interface RagStatus {
	chunks: number;
	files: number;
	lastIndexed: number | null;
}

/**
 * Owns the semantic index: which files are indexable, (re)embedding them
 * incrementally by content hash, debounced updates on vault changes, and the
 * search entry point used by the semantic_search tool. The store lives in the
 * plugin data dir and is loaded lazily so startup stays light.
 */
export class RagIndexer {
	private store = new RagStore();
	private loaded = false;
	/** Paths waiting for the debounced incremental flush. */
	private queued = new Set<string>();

	constructor(
		private app: App,
		private getSettings: () => VaultAssistantSettings,
		private dataDir: string,
	) {}

	private get indexPath(): string {
		return normalizePath(`${this.dataDir}/${INDEX_FILE}`);
	}

	/** Tail of the write-operation chain, so reindexes and flushes never interleave. */
	private writing: Promise<void> = Promise.resolve();

	/** Run `fn` after any in-flight indexing finishes; store mutations stay serialized. */
	private serialize<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.writing.then(fn);
		this.writing = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	private async ensureLoaded(): Promise<void> {
		if (this.loaded) return;
		await this.store.load(this.app.vault.adapter, this.indexPath);
		this.loaded = true;
	}

	private async persist(): Promise<void> {
		await this.store.save(this.app.vault.adapter, this.indexPath);
	}

	/**
	 * Which source a path belongs to, or null when it must not be indexed.
	 * The isReadable gate is the privacy boundary: blocked notes never get a
	 * vector. Wiki and conversations are separate opt-ins on top of the vault.
	 */
	private sourceFor(path: string, s: VaultAssistantSettings): Source | null {
		if (!path.endsWith('.md')) return null;
		if (!isReadable(path, s)) return null;
		if (inFolder(path, s.conversationsFolder)) return s.ragIndexConversations ? 'conversation' : null;
		if (inFolder(path, s.wikiFolder)) return s.ragIndexWiki ? 'wiki' : null;
		return 'vault';
	}

	/** Re-embed one file, reusing vectors for chunks whose content is unchanged. */
	private async indexFile(file: TFile, s: VaultAssistantSettings): Promise<void> {
		const source = this.sourceFor(file.path, s);
		if (!source) {
			this.store.removeFile(file.path);
			return;
		}

		const text = await this.app.vault.cachedRead(file);
		const chunks: Chunk[] =
			source === 'conversation'
				? chunkConversation(file.path, text)
				: chunkMarkdown(file.path, text);
		const hashes = chunks.map((c) => hashText(c.text));

		const previous = this.store.vectorsByHash(file.path);
		const missing = chunks.filter((_, i) => !previous.has(hashes[i] ?? ''));
		const embedded = new Map<string, Float32Array>();
		for (let i = 0; i < missing.length; i += BATCH) {
			const batch = missing.slice(i, i + BATCH);
			const vectors = await embed(
				s,
				batch.map((c) => c.text),
			);
			batch.forEach((c, j) => {
				const v = vectors[j];
				if (v) embedded.set(hashText(c.text), Float32Array.from(v));
			});
		}

		this.store.removeFile(file.path);
		chunks.forEach((c, i) => {
			const hash = hashes[i];
			const vec = hash ? (previous.get(hash) ?? embedded.get(hash)) : undefined;
			if (hash && vec) {
				this.store.add({ path: c.path, heading: c.heading, hash, text: c.text }, vec);
			}
		});
	}

	/** Full reindex: every indexable file, skipping unchanged chunks. */
	reindexAll(onProgress?: (done: number, total: number) => void): Promise<RagStatus> {
		const s = this.getSettings();
		if (!s.useRag) throw new Error('Semantic search is disabled in settings.');
		return this.serialize(async () => {
			await this.ensureLoaded();

			// A different embedding model produces incomparable vectors.
			if (this.store.model && this.store.model !== s.embedModel.trim()) this.store.clear();

			const files = this.app.vault.getMarkdownFiles().filter((f) => this.sourceFor(f.path, s));
			this.store.retainPaths(new Set(files.map((f) => f.path)));

			let done = 0;
			for (const file of files) {
				await this.indexFile(file, s);
				onProgress?.(++done, files.length);
			}

			this.store.model = s.embedModel.trim();
			this.store.lastIndexed = Date.now();
			await this.persist();
			return this.status0();
		});
	}

	// --- Incremental updates on vault events (debounced) ---

	private flush = debounce(
		() => {
			void this.flushQueued();
		},
		2000,
		true,
	);

	private async flushQueued(): Promise<void> {
		const s = this.getSettings();
		const paths = [...this.queued];
		this.queued.clear();
		if (!paths.length) return;
		try {
			await this.serialize(async () => {
				await this.ensureLoaded();
				for (const path of paths) {
					const f = this.app.vault.getAbstractFileByPath(path);
					if (f instanceof TFile) await this.indexFile(f, s);
					else this.store.removeFile(path);
				}
				this.store.lastIndexed = Date.now();
				await this.persist();
			});
		} catch (e) {
			console.error('Vault assistant: incremental semantic indexing failed.', e);
		}
	}

	/** Queue a changed/created file for re-embedding. Cheap; safe to call often. */
	queue(path: string): void {
		const s = this.getSettings();
		// Only files already indexed, or indexable now, are worth a flush.
		if (!s.useRag || !this.sourceFor(path, s)) return;
		this.queued.add(path);
		this.flush();
	}

	/** Drop a deleted file's chunks. */
	remove(path: string): void {
		if (!this.getSettings().useRag) return;
		this.queued.delete(path);
		void this.serialize(async () => {
			await this.ensureLoaded();
			if (!this.store.size) return;
			this.store.removeFile(path);
			await this.persist();
		}).catch((e) => console.error('Vault assistant: could not drop deleted file from index.', e));
	}

	/** Move a file's index entry: drop the old path, embed the new one. */
	rename(path: string, oldPath: string): void {
		this.remove(oldPath);
		this.queue(path);
	}

	// --- Search ---

	/** Embed the query and return formatted top-k results for the model. */
	async search(query: string, limit: number): Promise<string> {
		const s = this.getSettings();
		await this.ensureLoaded();
		if (!this.store.size) {
			return 'The semantic index is empty. Ask the user to run "Reindex vault for semantic search" (command palette or plugin settings).';
		}
		if (this.store.model && this.store.model !== s.embedModel.trim()) {
			return `Error: the semantic index was built with a different embedding model ("${this.store.model}"). Ask the user to reindex.`;
		}

		const queryVec = (await embed(s, [query]))[0];
		if (!queryVec) return 'Error: the embeddings endpoint returned no vector for the query.';
		const hits = this.store.search(queryVec, limit, (path) => isReadable(path, s));
		if (!hits.length) return 'No semantic matches found.';

		return hits
			.map((h) => {
				const where = h.entry.heading ? `${h.entry.path} › ${h.entry.heading}` : h.entry.path;
				const snippet = h.entry.text.replace(/\s+/g, ' ').trim().slice(0, 200);
				return `${where}: …${snippet}… (${h.score.toFixed(2)})`;
			})
			.join('\n');
	}

	private status0(): RagStatus {
		return {
			chunks: this.store.size,
			files: this.store.fileCount(),
			lastIndexed: this.store.lastIndexed,
		};
	}

	/** Index size and freshness, for the settings tab. */
	async status(): Promise<RagStatus> {
		await this.ensureLoaded();
		return this.status0();
	}
}
