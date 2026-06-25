import { Notice, Platform } from 'obsidian';
import { ToolSpec } from '../types';
import { McpServerConfig, VaultAssistantSettings } from '../settings';
import { McpTransport, createTransport } from './transport';

/** MCP protocol revision we advertise; servers negotiate down if needed. */
const PROTOCOL_VERSION = '2024-11-05';

interface McpToolDef {
	name: string;
	description?: string;
	inputSchema?: { properties?: Record<string, unknown>; required?: string[] };
}

interface RegisteredTool {
	spec: ToolSpec;
	serverId: string;
	originalName: string;
}

interface Connection {
	cfg: McpServerConfig;
	transport: McpTransport;
}

/**
 * Owns every MCP server connection and exposes their tools to the agent: it
 * lists them as namespaced ToolSpecs (`mcp__<serverId>__<tool>`) and routes
 * calls back out to the originating server.
 */
export class McpManager {
	private connections = new Map<string, Connection>();
	private tools = new Map<string, RegisteredTool>();

	/** (Re)connect to every enabled server. Per-server failures are non-fatal. */
	async connectAll(settings: VaultAssistantSettings): Promise<void> {
		this.dispose();
		for (const cfg of settings.mcpServers) {
			if (!cfg.enabled) continue;
			if (cfg.transport === 'stdio' && !Platform.isDesktopApp) {
				new Notice(`MCP "${cfg.name}" skipped: stdio servers need the desktop app.`);
				continue;
			}
			try {
				await this.connectServer(cfg);
			} catch (e) {
				new Notice(`MCP "${cfg.name}" failed: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
	}

	private async connectServer(cfg: McpServerConfig): Promise<void> {
		const transport = createTransport(cfg);
		try {
			await transport.request('initialize', {
				protocolVersion: PROTOCOL_VERSION,
				capabilities: {},
				clientInfo: { name: 'vault-assistant', version: '0.1.0' },
			});
			transport.notify('notifications/initialized');

			const listed = (await transport.request('tools/list')) as { tools?: McpToolDef[] };
			this.connections.set(cfg.id, { cfg, transport });
			for (const t of listed?.tools ?? []) {
				const name = `mcp__${cfg.id}__${t.name}`;
				this.tools.set(name, {
					serverId: cfg.id,
					originalName: t.name,
					spec: {
						name,
						description: t.description ?? `MCP tool "${t.name}" from ${cfg.name}.`,
						parameters: {
							type: 'object',
							properties: t.inputSchema?.properties ?? {},
							required: t.inputSchema?.required,
						},
					},
				});
			}
		} catch (e) {
			transport.close();
			throw e;
		}
	}

	/** Namespaced specs for every connected MCP tool. */
	toolSpecs(): ToolSpec[] {
		return [...this.tools.values()].map((t) => t.spec);
	}

	/** The server config behind a namespaced tool name (same object as in settings). */
	serverFor(name: string): McpServerConfig | undefined {
		const t = this.tools.get(name);
		return t ? this.connections.get(t.serverId)?.cfg : undefined;
	}

	isTrusted(name: string): boolean {
		return this.serverFor(name)?.trusted ?? false;
	}

	/** Invoke a namespaced MCP tool and return a model-ready string. */
	async callTool(name: string, argsJson: string): Promise<string> {
		const tool = this.tools.get(name);
		if (!tool) return `Error: unknown MCP tool "${name}".`;
		const conn = this.connections.get(tool.serverId);
		if (!conn) return `Error: MCP server for "${name}" is not connected.`;

		let args: unknown;
		try {
			args = JSON.parse(argsJson || '{}');
		} catch {
			return 'Error: tool arguments were not valid JSON.';
		}

		try {
			const res = (await conn.transport.request('tools/call', {
				name: tool.originalName,
				arguments: args,
			})) as { content?: Array<Record<string, unknown>>; isError?: boolean };
			const text = flattenContent(res?.content ?? []);
			return res?.isError ? `Error: ${text}` : text || '(no output)';
		} catch (e) {
			return `Error calling ${name}: ${e instanceof Error ? e.message : String(e)}`;
		}
	}

	dispose(): void {
		for (const { transport } of this.connections.values()) transport.close();
		this.connections.clear();
		this.tools.clear();
	}
}

/** Flatten an MCP content array into plain text for the model. */
function flattenContent(content: Array<Record<string, unknown>>): string {
	return content
		.map((c) => {
			if (c.type === 'text' && typeof c.text === 'string') return c.text;
			if (c.type === 'image') return '[image]';
			if (c.type === 'resource') {
				const r = c.resource as { uri?: string } | undefined;
				return `[resource: ${r?.uri ?? ''}]`;
			}
			return `[${typeof c.type === 'string' ? c.type : 'unknown'}]`;
		})
		.join('\n');
}
