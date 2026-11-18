import type { Ticket } from '~/Core/Tickets/Domain/Entities/Ticket/entity';

import { type EligibilityFacts, isDone, isEscalated, isUnattended, isUnblocked, isUnclaimed } from './eligibility';

/**
 * The values of a Ticket Status, in their order of precedence: when several apply
 * to one ticket, the first one is its Ticket Status. Unreadable is the Ticket
 * Status of a ticket its Source cannot read; no other value applies to it.
 */
export const derivedTicketStatuses = [
  'unreadable',
  'done',
  'escalated',
  'claimed',
  'not ready',
  'blocked',
  'eligible',
] as const;

/**
 * A Ticket's Ticket Status: its position in its lifecycle, derived from the
 * ticket, the Ledger, and done. It is not the `status` that a Ticket stores.
 */
export type DerivedTicketStatus = (typeof derivedTicketStatuses)[number];

/**
 * The Ticket Status of a ticket its Source read, so never unreadable. When several
 * values apply, the first of done, escalated, claimed, not ready, blocked, and
 * eligible is the one. Not ready means HITL yes. A ticket is eligible exactly when
 * it is Eligible.
 */
export const deriveTicketStatus = (
  ticket: Ticket,
  facts: EligibilityFacts
): Exclude<DerivedTicketStatus, 'unreadable'> => {
  if (isDone(ticket, facts.done)) {
    return 'done';
  }
  if (isEscalated(ticket, facts.escalated)) {
    return 'escalated';
  }
  if (!isUnclaimed(ticket, facts.claimed)) {
    return 'claimed';
  }
  if (!isUnattended(ticket)) {
    return 'not ready';
  }
  if (!isUnblocked(ticket, facts.done)) {
    return 'blocked';
  }
  return 'eligible';
};
