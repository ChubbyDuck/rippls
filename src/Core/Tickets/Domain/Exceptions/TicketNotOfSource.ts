import { Data } from 'effect';

import type { TicketId } from '../Entities/Ticket/properties/TicketId';

/** The ticket identity names no known Ticket Source, or another one than the one asked for. */
export class TicketNotOfSource extends Data.TaggedError('TicketNotOfSource')<{
  readonly ticketId: TicketId;
  readonly source?: string;
}> {
  override get message(): string {
    return this.source === undefined
      ? `${this.ticketId} names no known Ticket Source`
      : `${this.ticketId} is not a ticket of the ${this.source} Source`;
  }
}
