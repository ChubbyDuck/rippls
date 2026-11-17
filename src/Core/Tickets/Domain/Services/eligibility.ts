import type { Ticket } from '~/Core/Tickets/Domain/Entities/Ticket/entity';

/** A Ticket with no remaining blockers. */
export const isUnblocked = (ticket: Ticket): boolean => ticket.blockedBy.length === 0;

/** A Ticket not assigned to a Runner and not currently being claimed. */
export const isUnclaimed = (ticket: Ticket): boolean =>
  ticket.claimedBy === undefined && ticket.status !== 'claiming' && ticket.status !== 'claimed';

/** A Ticket whose HITL is no, allowing it to proceed without a human. */
export const isUnattended = (ticket: Ticket): boolean => ticket.hitl === 'no';

/**
 * The one eligibility rule of the Engine: an Unblocked, Unclaimed, Unattended
 * Ticket that the Engine may take next. A Ticket Source returns every ticket in
 * scope; this rule decides which of them the Engine may take.
 */
export const isEligible = (ticket: Ticket): boolean =>
  isUnblocked(ticket) && isUnclaimed(ticket) && isUnattended(ticket);
