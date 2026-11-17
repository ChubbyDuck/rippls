import type { Ticket } from '~/Core/Tickets/Domain/Entities/Ticket/entity';
import type { TicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';

/** A Ticket whose work is complete. A done Ticket is never Eligible. */
export const isDone = (ticket: Ticket): boolean => ticket.status === 'done';

/** The identities of the done Tickets among the tickets a Source returned. */
export const doneTickets = (tickets: readonly Ticket[]): ReadonlySet<TicketId> =>
  new Set(tickets.filter(isDone).map((ticket) => ticket.id));

/**
 * A Ticket whose blockers are all done. A blocker that is not among the done
 * tickets, because it is open or because the Source cannot find it, blocks.
 */
export const isUnblocked = (ticket: Ticket, done: ReadonlySet<TicketId>): boolean =>
  ticket.blockedBy.every((blocker) => done.has(blocker));

/** A Ticket not assigned to a Runner and not currently being claimed. */
export const isUnclaimed = (ticket: Ticket): boolean =>
  ticket.claimedBy === undefined && ticket.status !== 'claiming' && ticket.status !== 'claimed';

/** A Ticket whose HITL is no, allowing it to proceed without a human. */
export const isUnattended = (ticket: Ticket): boolean => ticket.hitl === 'no';

/**
 * The one eligibility rule of the Engine: an Unblocked, Unclaimed, Unattended
 * Ticket that is not done, which the Engine may take next. A Ticket Source
 * returns every ticket in scope, done ones included; this rule decides which of
 * them the Engine may take.
 */
export const isEligible = (ticket: Ticket, done: ReadonlySet<TicketId>): boolean =>
  !isDone(ticket) && isUnblocked(ticket, done) && isUnclaimed(ticket) && isUnattended(ticket);
