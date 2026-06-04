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
