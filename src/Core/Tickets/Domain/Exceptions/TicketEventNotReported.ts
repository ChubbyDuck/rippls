import { Data } from 'effect';

import type { TicketEvent } from '../Events/TicketEvent';
import type { TicketId } from '../Entities/Ticket/properties/TicketId';

export class TicketEventNotReported extends Data.TaggedError('TicketEventNotReported')<{
  readonly ticketId: TicketId;
  readonly event: TicketEvent;
}> {}
