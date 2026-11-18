import { Effect, Option } from 'effect';

import type { TicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';
import { TicketQuery } from '~/Core/Tickets/Domain/Queries/TicketQuery';
import { isDone } from '~/Core/Tickets/Domain/Services/eligibility';
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
 * The outstanding blockers of each ticket in scope that is not done and has any.
 * A blocker resolves to a ticket in scope, or, when the read was narrowed or the
 * Source does not offer it, to a ticket the Source finds by its identity.
 */
export const outstandingBlockers = ({
  tickets,
  facts,
}: Pick<TicketScope, 'tickets' | 'facts'>): Effect.Effect<ReadonlyMap<TicketId, OutstandingBlockers>, never, TicketSource> =>
  Effect.gen(function* () {
    const source = yield* TicketSource;
    const inScope = new Set(tickets.map((ticket) => ticket.id));
    const pending = tickets
      .filter((ticket) => !isDone(ticket, facts.done))
      .map((ticket) => [ticket.id, ticket.blockedBy.filter((blocker) => !facts.done.has(blocker))] as const)
      .filter(([, blockers]) => blockers.length > 0);
    const outside = [...new Set(pending.flatMap(([, blockers]) => blockers))].filter((blocker) => !inScope.has(blocker));
    const found = yield* Effect.forEach(outside, (blocker) =>
      source.getOneBy(TicketQuery.byId(blocker).build()).pipe(
        Effect.option,
        Effect.map((ticket) => [blocker, Option.isSome(ticket)] as const)
      )
    );
    const resolves = new Map<TicketId, boolean>([...[...inScope].map((id) => [id, true] as const), ...found]);
    return new Map(
      pending.map(([ticket, blockers]): [TicketId, OutstandingBlockers] => [
        ticket,
        {
          open: blockers.filter((blocker) => resolves.get(blocker) === true),
          unresolved: blockers.filter((blocker) => resolves.get(blocker) !== true),
        },
      ])
    );
  });
