import { Data } from 'effect';

import type { TicketKind } from '../Entities/Ticket/properties/TicketKind';

export class StrategyNotFound extends Data.TaggedError('StrategyNotFound')<{
  readonly kind: TicketKind;
}> {}
