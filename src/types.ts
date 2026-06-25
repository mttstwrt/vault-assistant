export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
	id: string;
	name: string;
	/** Raw JSON string as returned by the model. */
	arguments: string;
}

export interface ChatMessage {
	role: Role;
	content: string;
	/** Present on assistant messages that invoke tools. */
	toolCalls?: ToolCall[];
	/** Present on `tool` messages, linking back to the originating call. */
	toolCallId?: string;
}

/** A request to the user to approve an out-of-scope action. */
export interface ApprovalRequest {
	/** What kind of action needs approval. */
	kind: 'write' | 'mcp';
	/** The tool that wants to act (e.g. "write_file", "mcp__fs__read_file"). */
	tool: string;
	/** The target file path, relative to the vault root. Write requests only. */
	path?: string;
	/** The target file's parent folder, for "always allow this folder". Write requests only. */
	folder?: string;
	/** The MCP server id/name behind the tool. MCP requests only. */
	serverId?: string;
	serverName?: string;
}

/** The user's decision on an {@link ApprovalRequest}. */
export type ApprovalResult =
	| 'deny'
	| 'once'
	| 'session'
	| 'always-file'
	| 'always-folder'
	| 'always-trust';

/** OpenAI-style function schema describing a tool the model may call. */
export interface ToolSpec {
	name: string;
	description: string;
	parameters: {
		type: 'object';
		properties: Record<string, unknown>;
		required?: string[];
	};
}
