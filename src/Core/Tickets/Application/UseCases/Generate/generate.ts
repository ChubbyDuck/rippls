import { Effect } from 'effect';

import { NoTicketMatchesConstraints } from '~/Core/Tickets/Domain/Exceptions/NoTicketMatchesConstraints';
import { TicketRepository } from '~/Core/Tickets/Ports/TicketRepository';

import { type GenerateOptions, planTickets, resolvePlan } from './plan';

export const generateTickets = Effect.fn('harness.generate')(function* (options: GenerateOptions) {
  const repo = yield* TicketRepository;
  const plan = resolvePlan(options);

  if (plan.kindHitls.length === 0) {
    return yield* new NoTicketMatchesConstraints();
  }

  const tickets = planTickets(options.count, plan, options.chain);
  yield* Effect.forEach(tickets, (ticket) => repo.save(ticket));
  yield* Effect.annotateCurrentSpan({
    'generate.count': tickets.length,
    'generate.combinations': plan.kindHitls.length * plan.statuses.length * plan.projects.length,
  });

  return tickets.length;
});
