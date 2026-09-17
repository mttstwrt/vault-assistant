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

/**
 * One thing the chat panel showed, in the order it showed it.
 *
 * This — not the message list the endpoint receives — is the conversation.
 * A diff, an approval and an error are all part of what happened and none of
 * them is a `ChatMessage`, which is why a transcript rendered from messages
 * alone could never carry them. The wire history is a projection of this list
 * (see transcript.ts), so there is one record rather than two that can drift.
 */
export type TranscriptEntry =
	| {
			kind: 'user';
			/** What was typed, which is what the bubble shows. */
			text: string;
			/**
			 * Notes a typed [[link]] attached, appended to `text` before the model
			 * sees it. Kept apart so the bubble can show the message the user wrote
			 * rather than the message plus a few thousand characters of note.
			 */
			block?: string;
			/** What to report under the bubble about that attachment. */
			attached?: ExpansionSummary;
	  }
	| {
			kind: 'assistant';
			/** May be empty: a turn that only called tools still needs its entry. */
			text: string;
			/** Shown, never sent back to the endpoint. */
			reasoning?: string;
			/** How long the model spent reasoning, in milliseconds. */
			thoughtMs?: number;
			stats?: TurnStats;
			/** The user cut this turn short, so the text is partial. */
			aborted?: boolean;
	  }
	| { kind: 'tool'; call: ToolCall; result: string }
	| { kind: 'change'; path: string; change: 'create' | 'update'; diff: SerializedDiff }
	| { kind: 'approval'; request: ApprovalRequest; decision: ApprovalResult }
	| { kind: 'error'; message: string };

/** What the endpoint reported about a turn, as a transcript stores it. */
export interface TurnStats {
	elapsedMs: number;
	completionTokens?: number;
	tokensPerSecond?: number;
}

/**
 * A write as the transcript keeps it: the diff that was drawn, not the file's
 * before and after. Keeping both sides would put a second copy of every note
 * the agent touches into the conversations folder, and the diff is what was on
 * screen — which is the thing a transcript is a record of.
 */
export interface SerializedDiff {
	/** Unified-diff body: "+", "-", " " prefixes, and "⋯" for an elided gap. */
	body: string;
	added: number;
	removed: number;
	/** The change was too large to diff line by line. */
	truncated: boolean;
}

/** What the [[link]] expander did to a message, as the transcript keeps it. */
export interface ExpansionSummary {
	inlined: { path: string; subpath: string; label: string; chars: number }[];
	missed: { link: string; near: string | null }[];
	/** How many links pointed into blocked folders. */
	blocked: number;
	/** Links named but not attached, because the message hit its budget. */
	deferred: string[];
}
