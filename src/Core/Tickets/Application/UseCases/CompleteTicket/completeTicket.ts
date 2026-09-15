import { Effect } from 'effect';

import { TicketQuery } from '~/Core/Tickets/Domain/Queries/TicketQuery';
import { unblockDependents } from '~/Core/Tickets/Domain/Services/unblockDependents';
import { TicketSource } from '~/Core/Tickets/Ports/TicketSource';

import type { CompleteTicketCommand } from './command';

export const completeTicket = ({ ticketId }: CompleteTicketCommand) =>
  Effect.gen(function* () {
    const source = yield* TicketSource;
    const ticket = yield* source.getOneBy(TicketQuery.byId(ticketId).build());
    yield* source.save(ticket.done());
    const candidates = yield* source.getManyBy(TicketQuery.blockedBy(ticketId).build());
    const unblocked = unblockDependents(ticketId, candidates);
    yield* source.saveMany(unblocked);
  }).pipe(Effect.withSpan('tickets.complete', { attributes: { 'ticket.id': ticketId } }));
