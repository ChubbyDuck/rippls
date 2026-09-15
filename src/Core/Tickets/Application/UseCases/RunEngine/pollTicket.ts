import { Console, Effect, Option } from 'effect';

import type { Project } from '~/Core/Tickets/Domain/Entities/Ticket/properties/Project';
import { TicketQuery } from '~/Core/Tickets/Domain/Queries/TicketQuery';
import { TicketSource } from '~/Core/Tickets/Ports/TicketSource';

const nextReadyTicket = (project?: Project) => {
  const query = TicketQuery.unblocked().unclaimed().afk().sort('ASC');
  return (project === undefined ? query : query.byProject(project)).build();
};

export const pollTicket = (project?: Project) =>
  Effect.gen(function* () {
    const source = yield* TicketSource;
    const found = yield* source.getOneBy(nextReadyTicket(project)).pipe(
      Effect.asSome,
      Effect.catchTag('TicketNotFound', () => Effect.succeedNone)
    );

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
    const source = yield* TicketSource;
    const ticket = yield* source.getOneBy(nextReadyTicket(project)).pipe(
      Effect.tap((found) =>
        Effect.annotateCurrentSpan({ 'ticket.read.outcome': 'ticket', 'ticket.id': found.id })
      ),
      Effect.asSome,
      Effect.tapError(() => Effect.annotateCurrentSpan('ticket.read.outcome', 'error')),
      Effect.catchTag('TicketNotFound', () =>
        Effect.annotateCurrentSpan('ticket.read.outcome', 'empty').pipe(Effect.as(Option.none()))
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
