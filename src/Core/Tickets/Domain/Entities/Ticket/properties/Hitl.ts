import { Schema } from 'effect';

export const Hitl = Schema.Literals(['no', 'yes']);

export type Hitl = typeof Hitl.Type;

/** The HITL of a ticket that states no HITL, no Marker, and no Ticket Kind that implies one. */
export const fallbackHitl: Hitl = 'yes';
