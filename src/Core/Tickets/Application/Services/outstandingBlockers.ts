import type { TicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';
import { isDone } from '~/Core/Tickets/Domain/Services/eligibility';

import type { TicketScope } from './ticketScope';

/**
 * The blockers of a ticket that are not done: open when the Source resolves the
 * blocker, unresolved when it cannot find it. Both keep the ticket blocked.
 */
export type OutstandingBlockers = {
  readonly open: readonly TicketId[];
  readonly unresolved: readonly TicketId[];
};

/**
 * The outstanding blockers of each ticket in scope that is not done and has any,
 * each blocker once. A blocker is open when the Source resolved it, by a read of
 * tickets or by its identity, and unresolved otherwise.
 */
export const outstandingBlockers = ({
  tickets,
  facts,
  resolved,
}: Pick<TicketScope, 'tickets' | 'facts' | 'resolved'>): ReadonlyMap<TicketId, OutstandingBlockers> => {
  const outstanding = new Map<TicketId, OutstandingBlockers>();
  for (const ticket of tickets) {
    if (isDone(ticket, facts.done)) {
      continue;
    }
    const blockers = [...new Set(ticket.blockedBy)].filter((blocker) => !facts.done.has(blocker));
    if (blockers.length > 0) {
      outstanding.set(ticket.id, {
        open: blockers.filter((blocker) => resolved.has(blocker)),
        unresolved: blockers.filter((blocker) => !resolved.has(blocker)),
      });
    }
  }
  return outstanding;
};
