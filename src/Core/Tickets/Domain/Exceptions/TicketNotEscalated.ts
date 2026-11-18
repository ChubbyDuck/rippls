import { Data } from 'effect';

import type { TicketId } from '../Entities/Ticket/properties/TicketId';

export class TicketNotEscalated extends Data.TaggedError('TicketNotEscalated')<{
  readonly ticketId: TicketId;
}> {
  override get message(): string {
    return `${this.ticketId} is not escalated, so there is nothing to retry`;
  }
}
