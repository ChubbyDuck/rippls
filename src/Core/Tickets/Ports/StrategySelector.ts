import { Context, type Effect } from 'effect';

import type { TicketKind } from '../Domain/Entities/Ticket/properties/TicketKind';
import type { StrategyNotFound } from '../Domain/Exceptions/StrategyNotFound';
import type { Strategy } from './Strategy';

export class StrategySelector extends Context.Service<
  StrategySelector,
  {
    readonly select: (kind: TicketKind) => Effect.Effect<Strategy, StrategyNotFound>;
  }
>()('StrategySelector') {}
