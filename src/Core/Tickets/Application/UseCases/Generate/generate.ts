import { Effect } from 'effect';

import { NoTicketMatchesConstraints } from '~/Core/Tickets/Domain/Exceptions/NoTicketMatchesConstraints';
import { TicketSource } from '~/Core/Tickets/Ports/TicketSource';

import { type GenerateOptions, planTickets, resolvePlan } from './plan';

export const generateTickets = Effect.fn('engine.generate')(function* (options: GenerateOptions) {
  const source = yield* TicketSource;
  const plan = resolvePlan(options);

  if (plan.kindHitls.length === 0) {
    return yield* new NoTicketMatchesConstraints();
  }

  const tickets = planTickets(options.count, plan, options.chain);
  yield* Effect.forEach(tickets, (ticket) => source.save(ticket));
  yield* Effect.annotateCurrentSpan({
    'generate.count': tickets.length,
    'generate.combinations': plan.kindHitls.length * plan.statuses.length * plan.projects.length,
  });

  return tickets.length;
});
