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

/**
 * A write the agent made, so the panel can show it as a diff. This never goes
 * back to the model — it only ever sees the short "Updated <path>" result.
 */
export interface FileChange {
	path: string;
	kind: 'create' | 'update';
	/** The file's contents before the write; '' for a new file. */
	before: string;
	after: string;
}

/** A request to the user to approve an out-of-scope action. */
export interface ApprovalRequest {
	/**
	 * What kind of action needs approval. 'move' and 'create-folder' are their
	 * own kinds rather than writes because neither has a content diff to show,
	 * and rendering one as a write would draw a whole-file deletion that is not
	 * happening.
	 */
	kind: 'write' | 'mcp' | 'move' | 'create-folder';
	/** The tool that wants to act (e.g. "write_file", "mcp__fs__read_file"). */
	tool: string;
	/** The target file path, relative to the vault root. Write requests only. */
	path?: string;
	/** Where a move would land. Move requests only. */
	toPath?: string;
	/** The target file's parent folder, for "always allow this folder". Write requests only. */
	folder?: string;
	/**
	 * The write being asked about, so the card can show it as a diff before you
	 * allow it. Write requests only, and never sent to the model.
	 */
	preview?: { before: string; after: string };
	/** The MCP server id/name behind the tool. MCP requests only. */
	serverId?: string;
	serverName?: string;
	/** The call's JSON arguments, so the user sees exactly what is sent. MCP requests only. */
	args?: string;
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
