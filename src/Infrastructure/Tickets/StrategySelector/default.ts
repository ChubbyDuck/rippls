import { Effect, Layer } from 'effect';

import type { TicketKind } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketKind';
import { StrategyNotFound } from '~/Core/Tickets/Domain/Exceptions/StrategyNotFound';
import type { Strategy } from '~/Core/Tickets/Ports/Strategy';
import { StrategySelector } from '~/Core/Tickets/Ports/StrategySelector';

import { implementationStrategy } from './implementation';
import { named } from './noop';

// The implementation kind runs the real strategy. Every other kind keeps the
// logging strategy until it gets its own implementation.
const stored: Partial<Record<TicketKind, Strategy>> = {
  implementation: implementationStrategy,
  research: named('research'),
  prototype: named('prototype'),
  grilling: named('grilling'),
  task: named('task'),
};

export const StrategySelectorDefault = Layer.succeed(StrategySelector, {
  select: (kind) => {
    const strategy = stored[kind];
    return strategy === undefined ? Effect.fail(new StrategyNotFound({ kind })) : Effect.succeed(strategy);
  },
});
