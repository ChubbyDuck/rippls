import { Schema } from 'effect';

export const Hitl = Schema.Literals(['no', 'yes']);

export type Hitl = typeof Hitl.Type;
