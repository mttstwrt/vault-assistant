import { requestUrl } from 'obsidian';
import type { ChildProcess } from 'child_process';
import { McpServerConfig } from '../settings';

/**
 * The minimal JSON-RPC surface an MCP server connection needs for tool use:
 * request/response, one-way notifications, and teardown.
 */
export interface McpTransport {
	request(method: string, params?: unknown): Promise<unknown>;
	notify(method: string, params?: unknown): void;
	close(): void;
}

interface JsonRpcResponse {
	id?: number | string;
	result?: unknown;
	error?: { code: number; message: string };
}

/** Build the right transport for a server config. */
export function createTransport(cfg: McpServerConfig): McpTransport {
	return cfg.transport === 'http' ? new HttpTransport(cfg) : new StdioTransport(cfg);
}

/** Pull the JSON-RPC payload out of a body that may be raw JSON or an SSE stream. */
function parseRpcBody(text: string): JsonRpcResponse {
	const trimmed = text.trim();
	try {
		return JSON.parse(trimmed) as JsonRpcResponse;
	} catch {
		// Streamable-HTTP servers answer with text/event-stream; take the last data: line.
		const data = trimmed
			.split('\n')
			.filter((l) => l.startsWith('data:'))
			.map((l) => l.slice(5).trim())
			.join('');
		return JSON.parse(data) as JsonRpcResponse;
	}
}

/** Remote MCP over HTTP, using Obsidian's requestUrl to sidestep CORS. */
class HttpTransport implements McpTransport {
	private nextId = 1;
	private sessionId: string | null = null;

	constructor(private cfg: McpServerConfig) {}

	private headers(): Record<string, string> {
		const h: Record<string, string> = {
			'Content-Type': 'application/json',
			Accept: 'application/json, text/event-stream',
			...(this.cfg.headers ?? {}),
		};
		if (this.sessionId) h['Mcp-Session-Id'] = this.sessionId;
		return h;
	}

	private async post(payload: Record<string, unknown>): Promise<string> {
		if (!this.cfg.url) throw new Error('MCP http server has no url configured.');
		const res = await requestUrl({
			url: this.cfg.url,
			method: 'POST',
			headers: this.headers(),
			body: JSON.stringify(payload),
			throw: false,
		});
		const sid = res.headers?.['mcp-session-id'] ?? res.headers?.['Mcp-Session-Id'];
		if (sid) this.sessionId = sid;
		if (res.status >= 400) {
			throw new Error(`MCP http error ${res.status}: ${(res.text ?? '').slice(0, 300)}`);
		}
		return res.text ?? '';
	}

	async request(method: string, params?: unknown): Promise<unknown> {
		const id = this.nextId++;
		const text = await this.post({ jsonrpc: '2.0', id, method, params });
		const rpc = parseRpcBody(text);
		if (rpc.error) throw new Error(`MCP ${method} failed: ${rpc.error.message}`);
		return rpc.result;
	}

	notify(method: string, params?: unknown): void {
		void this.post({ jsonrpc: '2.0', method, params }).catch(() => {});
	}

	close(): void {
		this.sessionId = null;
	}
}

/** Local MCP server spawned as a child process, talking newline-delimited JSON-RPC. */
class StdioTransport implements McpTransport {
	private proc: ChildProcess;
	private nextId = 1;
	private buffer = '';
	private pending = new Map<
		number,
		{ resolve: (v: unknown) => void; reject: (e: Error) => void }
	>();

	constructor(cfg: McpServerConfig) {
		if (!cfg.command) throw new Error('MCP stdio server has no command configured.');
		// Lazy require so this module still loads on platforms without child_process.
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const { spawn } = require('child_process') as typeof import('child_process');
		this.proc = spawn(cfg.command, cfg.args ?? [], {
			env: { ...process.env, ...(cfg.env ?? {}) },
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		this.proc.stdout?.on('data', (chunk: Buffer) => this.onData(chunk.toString()));
		this.proc.on('exit', () => this.failAll('MCP server process exited.'));
		this.proc.on('error', (e: Error) => this.failAll(`MCP server process error: ${e.message}`));
	}

	private onData(text: string): void {
		this.buffer += text;
		let nl: number;
		while ((nl = this.buffer.indexOf('\n')) >= 0) {
			const line = this.buffer.slice(0, nl).trim();
			this.buffer = this.buffer.slice(nl + 1);
			if (!line) continue;
			let rpc: JsonRpcResponse;
			try {
				rpc = JSON.parse(line) as JsonRpcResponse;
			} catch {
				continue; // ignore non-JSON log lines on stdout
			}
			if (rpc.id === undefined) continue; // server notification/request: ignored
			const waiter = this.pending.get(Number(rpc.id));
			if (!waiter) continue;
			this.pending.delete(Number(rpc.id));
			if (rpc.error) waiter.reject(new Error(rpc.error.message));
			else waiter.resolve(rpc.result);
		}
	}

	private failAll(message: string): void {
		for (const { reject } of this.pending.values()) reject(new Error(message));
		this.pending.clear();
	}

	request(method: string, params?: unknown): Promise<unknown> {
		const id = this.nextId++;
		return new Promise<unknown>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.write({ jsonrpc: '2.0', id, method, params });
		});
	}

	notify(method: string, params?: unknown): void {
		this.write({ jsonrpc: '2.0', method, params });
	}

	private write(payload: Record<string, unknown>): void {
		this.proc.stdin?.write(JSON.stringify(payload) + '\n');
	}

	close(): void {
		this.failAll('MCP connection closed.');
		this.proc.kill();
	}
}
