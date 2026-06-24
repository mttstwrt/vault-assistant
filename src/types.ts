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

/** A request to the user to approve a write outside the allowed folders. */
export interface ApprovalRequest {
	/** The tool that wants to write (e.g. "write_file"). */
	tool: string;
	/** The target file path, relative to the vault root. */
	path: string;
	/** The target file's parent folder, for the "always allow this folder" option. */
	folder: string;
}

/** The user's decision on an {@link ApprovalRequest}. */
export type ApprovalResult = 'deny' | 'once' | 'session' | 'always-file' | 'always-folder';

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
