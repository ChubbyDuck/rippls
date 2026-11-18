import { Effect, Option } from 'effect';

import type { TicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';
import { TicketQuery } from '~/Core/Tickets/Domain/Queries/TicketQuery';
import { isDone, isDoneInSource } from '~/Core/Tickets/Domain/Services/eligibility';
import { TicketSource } from '~/Core/Tickets/Ports/TicketSource';

import type { TicketScope } from './ticketScope';

/**
 * The blockers of a ticket that are not done: open when the Source reads the
 * blocker, unresolved when it cannot find it. Both keep the ticket blocked.
 */
export type OutstandingBlockers = {
  readonly open: readonly TicketId[];
  readonly unresolved: readonly TicketId[];
};

/**
 * The outstanding blockers of each ticket in scope that is not done and has any,
 * each blocker once. A blocker resolves to a ticket in scope, or, when the read was
 * narrowed or the Source does not offer it, to a ticket the Source finds by its
 * identity. A blocker found that way that its Source sees as done is not
 * outstanding.
 */
export const outstandingBlockers = ({
  tickets,
  facts,
}: Pick<TicketScope, 'tickets' | 'facts'>): Effect.Effect<ReadonlyMap<TicketId, OutstandingBlockers>, never, TicketSource> =>
  Effect.gen(function* () {
    const source = yield* TicketSource;
    const inScope = new Set(tickets.map((ticket) => ticket.id));
    const notDone = (blocker: TicketId) => !facts.done.has(blocker);
    const outside = [
      ...new Set(
        tickets
          .filter((ticket) => !isDone(ticket, facts.done))
          .flatMap((ticket) => ticket.blockedBy.filter((blocker) => notDone(blocker) && !inScope.has(blocker)))
      ),
    ];
    const found = yield* Effect.forEach(outside, (blocker) =>
      source.getOneBy(TicketQuery.byId(blocker).build()).pipe(
        Effect.option,
        Effect.map((ticket) => [blocker, Option.map(ticket, isDoneInSource)] as const)
      )
    );
    // Whether each blocker outside the scope was found, and whether it is done.
    const outsideFound = new Map(found);
    const lookup = (blocker: TicketId) => outsideFound.get(blocker) ?? Option.none<boolean>();
    const resolves = (blocker: TicketId) => inScope.has(blocker) || Option.isSome(lookup(blocker));
    const doneOutside = (blocker: TicketId) => Option.getOrElse(lookup(blocker), () => false);
    const outstanding = new Map<TicketId, OutstandingBlockers>();
    for (const ticket of tickets) {
      if (isDone(ticket, facts.done)) {
        continue;
      }
      const blockers = [...new Set(ticket.blockedBy)].filter((blocker) => notDone(blocker) && !doneOutside(blocker));
      if (blockers.length > 0) {
        outstanding.set(ticket.id, {
          open: blockers.filter(resolves),
          unresolved: blockers.filter((blocker) => !resolves(blocker)),
        });
      }
    }
    return outstanding;
  });
