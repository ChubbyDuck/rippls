import { Console, Effect, Layer } from 'effect';

import type { TicketKind } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketKind';
import { StrategyNotFound } from '~/Core/Tickets/Domain/Exceptions/StrategyNotFound';
import { StrategyRuntimeError } from '~/Core/Tickets/Domain/Exceptions/StrategyRuntimeError';
import type { Strategy } from '~/Core/Tickets/Ports/Strategy';
import { StrategySelector } from '~/Core/Tickets/Ports/StrategySelector';

export const named = (name: string): Strategy => ({
  name,
  run: (ticket, harness) =>
    Console.log(ticket.body).pipe(
      Effect.andThen(harness.run(`${ticket.title}\n\n${ticket.body}`, { label: `ticket-${ticket.id}` })),
      Effect.asVoid,
      Effect.mapError(() => new StrategyRuntimeError()),
      Effect.result
    ),
});

const stored: Partial<Record<TicketKind, Strategy>> = {
  implementation: named('implementation'),
  research: named('research'),
  prototype: named('prototype'),
  grilling: named('grilling'),
  task: named('task'),
};

export const StrategySelectorNoop = Layer.succeed(StrategySelector, {
  select: (kind) => {
    const strategy = stored[kind];
    return strategy === undefined ? Effect.fail(new StrategyNotFound({ kind })) : Effect.succeed(strategy);
  },
});
