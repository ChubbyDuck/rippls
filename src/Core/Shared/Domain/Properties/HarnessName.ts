import { Schema } from 'effect';

export const HarnessName = Schema.Literals(['Codex', 'Cursor', 'Claude', 'OpenCode']);

export type HarnessName = typeof HarnessName.Type;
