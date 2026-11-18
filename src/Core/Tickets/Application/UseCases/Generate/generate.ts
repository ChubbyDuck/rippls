import { Effect } from 'effect';

import { NoTicketMatchesConstraints } from '~/Core/Tickets/Domain/Exceptions/NoTicketMatchesConstraints';
import { FixtureWriter } from '~/Core/Tickets/Ports/FixtureWriter';

import { type GenerateOptions, planTickets, resolvePlan } from './plan';

export const generateTickets = Effect.fn('engine.generate')(function* (options: GenerateOptions) {
  const writer = yield* FixtureWriter;
  const plan = resolvePlan(options);

  if (plan.kindHitls.length === 0) {
    return yield* new NoTicketMatchesConstraints();
  }

  const tickets = planTickets(options.count, plan, options.chain);
  yield* writer.write(tickets);
  yield* Effect.annotateCurrentSpan({
    'generate.count': tickets.length,
    'generate.combinations': plan.kindHitls.length * plan.statuses.length * plan.projects.length,
  });

  return tickets.length;
});
