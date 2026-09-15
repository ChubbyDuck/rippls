import { Data } from 'effect';

import type { TicketId } from '../Entities/Ticket/properties/TicketId';

export class EngineHalted extends Data.TaggedError('EngineHalted')<{
  readonly ticketId: TicketId;
  readonly reason: string;
}> {}
