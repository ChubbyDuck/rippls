import { Context, type Effect } from 'effect';

import type { TicketKind } from '../Domain/Entities/Ticket/properties/TicketKind';
import type { StrategyNotFound } from '../Domain/Exceptions/StrategyNotFound';
import type { Strategy } from './Strategy';

export class StrategyRepository extends Context.Service<
  StrategyRepository,
  {
    readonly getOneBy: (kind: TicketKind) => Effect.Effect<Strategy, StrategyNotFound>;
  }
>()('StrategyRepository') {}
