import { Console, Effect, Option } from 'effect';

import type { Ticket } from '~/Core/Tickets/Domain/Entities/Ticket/entity';
import type { Project } from '~/Core/Tickets/Domain/Entities/Ticket/properties/Project';
import { TicketQuery } from '~/Core/Tickets/Domain/Queries/TicketQuery';
import { isEligible } from '~/Core/Tickets/Domain/Services/eligibility';
import { TicketSource } from '~/Core/Tickets/Ports/TicketSource';

const inScope = (project?: Project) => (project === undefined ? TicketQuery : TicketQuery.byProject(project)).build();

// The Source returns every ticket in scope in its processing order, and the core
// rule picks the first Eligible one. The chosen ticket is read again by identity,
// so it carries its full content and is still Eligible when it is taken.
const nextEligibleTicket = (project?: Project) =>
  Effect.gen(function* () {
    const source = yield* TicketSource;
    const tickets = yield* source.getManyBy(inScope(project));
    const candidate = tickets.find(isEligible);
    if (candidate === undefined) {
      return Option.none<Ticket>();
    }
    return yield* source.getOneBy(TicketQuery.byId(candidate.id).build()).pipe(
      Effect.map(Option.liftPredicate(isEligible)),
      Effect.catchTag('TicketNotFound', () => Effect.succeedNone)
    );
  });

export const pollTicket = (project?: Project) =>
  Effect.gen(function* () {
    const source = yield* TicketSource;
    const found = yield* nextEligibleTicket(project);

    if (Option.isNone(found)) {
      yield* Console.log('No tickets are found, continuing');
      return Option.none();
    }

    const claiming = found.value.markClaiming();
    yield* source.save(claiming);
    return Option.some(claiming);
  });

const _pollTicketTraced = (project?: Project) =>
  Effect.gen(function* () {
    const ticket = yield* nextEligibleTicket(project).pipe(
      Effect.tap(
        Option.match({
          onNone: () => Effect.annotateCurrentSpan('ticket.read.outcome', 'empty'),
          onSome: (found) => Effect.annotateCurrentSpan({ 'ticket.read.outcome': 'ticket', 'ticket.id': found.id }),
        })
      ),
      Effect.withSpan('ticket.read')
    );

    if (Option.isNone(ticket)) {
      yield* Console.log('No tickets are found, continuing');
      yield* Effect.sleep('1 second').pipe(
        Effect.withSpan('ticket.retry.wait', { attributes: { 'ticket.retry.reason': 'empty' } })
      );
    }

    return ticket;
  });
