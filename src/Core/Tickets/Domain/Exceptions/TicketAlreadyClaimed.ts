import { Data } from 'effect';

import type { TicketId } from '../Entities/Ticket/properties/TicketId';

export class TicketAlreadyClaimed extends Data.TaggedError('TicketAlreadyClaimed')<{
  readonly ticketId: TicketId;
}> {}
