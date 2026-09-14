import { Effect } from 'effect';

import { TicketQuery } from '~/Core/Tickets/Domain/Queries/TicketQuery';
import { unblockDependents } from '~/Core/Tickets/Domain/Services/unblockDependents';
import { TicketRepository } from '~/Core/Tickets/Ports/TicketRepository';

import type { CompleteTicketCommand } from './command';

export const completeTicket = ({ ticketId }: CompleteTicketCommand) =>
  Effect.gen(function* () {
    const repo = yield* TicketRepository;
    const ticket = yield* repo.getOneBy(TicketQuery.byId(ticketId).build());
    yield* repo.save(ticket.done());
    const candidates = yield* repo.getManyBy(TicketQuery.blockedBy(ticketId).build());
    const unblocked = unblockDependents(ticketId, candidates);
    yield* repo.saveMany(unblocked);
  }).pipe(Effect.withSpan('tickets.complete', { attributes: { 'ticket.id': ticketId } }));
