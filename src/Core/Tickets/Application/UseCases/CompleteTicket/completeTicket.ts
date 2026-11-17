import { Effect } from 'effect';

import { TicketQuery } from '~/Core/Tickets/Domain/Queries/TicketQuery';
import { TicketSource } from '~/Core/Tickets/Ports/TicketSource';

import type { CompleteTicketCommand } from './command';

// Completing a ticket writes only that ticket. Its dependents become Unblocked
// because the core eligibility rule finds it done, not because they are edited.
export const completeTicket = ({ ticketId }: CompleteTicketCommand) =>
  Effect.gen(function* () {
    const source = yield* TicketSource;
    const ticket = yield* source.getOneBy(TicketQuery.byId(ticketId).build());
    yield* source.save(ticket.done());
  }).pipe(Effect.withSpan('tickets.complete', { attributes: { 'ticket.id': ticketId } }));
