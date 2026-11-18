import { Effect, Schema } from 'effect';

import { TicketSourceTag } from '~/Core/Shared/Domain/EngineConfig';
import { parseTicketId, type TicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';
import { TicketNotOfSource } from '~/Core/Tickets/Domain/Exceptions/TicketNotOfSource';

const isTicketSourceTag = Schema.is(TicketSourceTag);

/**
 * The Ticket Source that hears a retry: the one the ticket identity names. A
 * Source that is asked for and is not that one fails, before anything changes.
 */
export const retrySourceOf = (ticket: TicketId, asked?: TicketSourceTag) => {
  const named = parseTicketId(ticket).source;
  if (!isTicketSourceTag(named)) {
    return Effect.fail(new TicketNotOfSource({ ticketId: ticket }));
  }
  return asked === undefined || asked === named
    ? Effect.succeed(named)
    : Effect.fail(new TicketNotOfSource({ ticketId: ticket, source: asked }));
};
