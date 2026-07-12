import type { DataAdapter } from 'obsidian';

/** One indexed chunk: provenance, a content hash, and the text itself. */
export interface StoredChunk {
	path: string;
	heading: string;
	hash: string;
	text: string;
}

export interface SearchHit {
	entry: StoredChunk;
	score: number;
}

interface PersistedIndex {
	version: 1;
	model: string;
	dim: number;
	lastIndexed: number | null;
	entries: StoredChunk[];
	/** All vectors concatenated, as base64 of the Float32Array bytes. */
	vectors: string;
}

/** FNV-1a content hash, used to skip re-embedding unchanged chunks. */
export function hashText(text: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16) + text.length.toString(16);
}

function toBase64(bytes: Uint8Array): string {
	let bin = '';
	for (let i = 0; i < bytes.length; i += 0x8000) {
		bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return btoa(bin);
}

function fromBase64(b64: string): Uint8Array {
	const bin = atob(b64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return bytes;
}

/** Scale a vector to unit length so similarity is a plain dot product. */
function normalize(v: Float32Array): Float32Array {
	let sum = 0;
	for (const x of v) sum += x * x;
	const n = Math.sqrt(sum);
	if (n > 0) for (let i = 0; i < v.length; i++) v[i] = (v[i] ?? 0) / n;
	return v;
}

/**
 * The vector store: in-memory unit vectors + brute-force cosine top-k, which
 * is plenty at personal-vault scale and needs no dependency. Persists to a
 * JSON file in the plugin's data dir — off-vault, so the index never appears
 * in the user's notes or sync.
 */
export class RagStore {
	private entries: StoredChunk[] = [];
	private vectors: Float32Array[] = [];
	private dim = 0;
	model = '';
	lastIndexed: number | null = null;

	get size(): number {
		return this.entries.length;
	}

	fileCount(): number {
		return new Set(this.entries.map((e) => e.path)).size;
	}

	clear(): void {
		this.entries = [];
		this.vectors = [];
		this.dim = 0;
		this.lastIndexed = null;
	}

	/** hash → vector for a file's current chunks, for reuse on reindex. */
	vectorsByHash(path: string): Map<string, Float32Array> {
		const map = new Map<string, Float32Array>();
		this.entries.forEach((e, i) => {
			const v = this.vectors[i];
			if (e.path === path && v) map.set(e.hash, v);
		});
		return map;
	}

	removeFile(path: string): void {
		for (let i = this.entries.length - 1; i >= 0; i--) {
			if (this.entries[i]?.path === path) {
				this.entries.splice(i, 1);
				this.vectors.splice(i, 1);
			}
		}
	}

	/** Drop entries whose file is no longer part of the indexable set. */
	retainPaths(keep: Set<string>): void {
		for (let i = this.entries.length - 1; i >= 0; i--) {
			const e = this.entries[i];
			if (e && !keep.has(e.path)) {
				this.entries.splice(i, 1);
				this.vectors.splice(i, 1);
			}
		}
	}

	/** Add one chunk. `vector` may be raw (it is normalized in place). */
	add(entry: StoredChunk, vector: Float32Array): void {
		if (this.dim && vector.length !== this.dim) {
			throw new Error(
				`Embedding dimension changed (${vector.length} vs ${this.dim}) — reindex with a single model.`,
			);
		}
		this.dim = vector.length;
		this.entries.push(entry);
		this.vectors.push(normalize(vector));
	}

	/** Brute-force cosine top-k over chunks whose path passes `allowed`. */
	search(query: number[], k: number, allowed: (path: string) => boolean): SearchHit[] {
		if (!this.size || query.length !== this.dim) return [];
		const q = normalize(Float32Array.from(query));
		const hits: SearchHit[] = [];
		for (let i = 0; i < this.entries.length; i++) {
			const entry = this.entries[i];
			const v = this.vectors[i];
			if (!entry || !v || !allowed(entry.path)) continue;
			let dot = 0;
			for (let j = 0; j < q.length; j++) dot += (q[j] ?? 0) * (v[j] ?? 0);
			hits.push({ entry, score: dot });
		}
		hits.sort((a, b) => b.score - a.score);
		return hits.slice(0, k);
	}

	async load(adapter: DataAdapter, file: string): Promise<void> {
		this.clear();
		this.model = '';
		if (!(await adapter.exists(file))) return;
		try {
			const parsed = JSON.parse(await adapter.read(file)) as PersistedIndex;
			if (parsed.version !== 1 || !Array.isArray(parsed.entries)) return;
			const bytes = fromBase64(parsed.vectors);
			const all = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
			if (parsed.dim <= 0 || all.length !== parsed.entries.length * parsed.dim) return;
			this.entries = parsed.entries;
			this.dim = parsed.dim;
			this.model = parsed.model ?? '';
			this.lastIndexed = parsed.lastIndexed ?? null;
			this.vectors = this.entries.map((_, i) =>
				all.slice(i * parsed.dim, (i + 1) * parsed.dim),
			);
		} catch (e) {
			console.error('Vault assistant: could not load the semantic index, starting empty.', e);
			this.clear();
		}
	}

	async save(adapter: DataAdapter, file: string): Promise<void> {
		const all = new Float32Array(this.size * this.dim);
		this.vectors.forEach((v, i) => all.set(v, i * this.dim));
		const payload: PersistedIndex = {
			version: 1,
			model: this.model,
			dim: this.dim,
			lastIndexed: this.lastIndexed,
			entries: this.entries,
			vectors: toBase64(new Uint8Array(all.buffer)),
		};
		await adapter.write(file, JSON.stringify(payload));
	}
}
