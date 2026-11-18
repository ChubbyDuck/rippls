import { Schema } from 'effect';

import type { Hitl } from './Hitl';

export const TicketKind = Schema.Literals(['implementation', 'research', 'prototype', 'grilling', 'task']);

export type TicketKind = typeof TicketKind.Type;

export type ImpliedHitlKind = Exclude<TicketKind, 'task'>;

/** The HITL that a stated Ticket Kind implies. A task implies none. */
export const impliedHitlByKind = {
  implementation: 'no',
  research: 'no',
  prototype: 'yes',
  grilling: 'yes',
} as const satisfies Record<ImpliedHitlKind, Hitl>;

export const hitlImpliedBy = (kind: TicketKind): Hitl | undefined =>
  kind === 'task' ? undefined : impliedHitlByKind[kind];
