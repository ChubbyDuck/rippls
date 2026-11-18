import { Schema } from 'effect';

import type { Hitl } from './Hitl';

export const TicketKind = Schema.Literals(['implementation', 'research', 'prototype', 'grilling', 'task']);

export type TicketKind = typeof TicketKind.Type;

/** The Ticket Kind of a ticket that states none, unless config sets another. It implies no HITL. */
export const defaultTicketKind: TicketKind = 'implementation';

type ImpliedHitlKind = Exclude<TicketKind, 'task'>;

const impliedHitlByKind = {
  implementation: 'no',
  research: 'no',
  prototype: 'yes',
  grilling: 'yes',
} as const satisfies Record<ImpliedHitlKind, Hitl>;

/** The HITL that a stated Ticket Kind implies. A task implies none. */
export const hitlImpliedBy = (kind: TicketKind): Hitl | undefined =>
  kind === 'task' ? undefined : impliedHitlByKind[kind];
