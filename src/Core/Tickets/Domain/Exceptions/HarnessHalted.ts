import { Data } from 'effect';

import type { TicketId } from '../Entities/Ticket/properties/TicketId';

export class HarnessHalted extends Data.TaggedError('HarnessHalted')<{
  readonly ticketId: TicketId;
  readonly reason: string;
}> {}
