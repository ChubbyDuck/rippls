import { Schema } from 'effect';

export const AgentName = Schema.Literals(['Codex', 'Cursor', 'Claude', 'OpenCode']);

export type AgentName = typeof AgentName.Type;
