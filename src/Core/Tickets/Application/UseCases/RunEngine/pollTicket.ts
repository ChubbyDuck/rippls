import { Console, Effect, Option, Result } from 'effect';

import type { Ticket } from '~/Core/Tickets/Domain/Entities/Ticket/entity';
import type { Project } from '~/Core/Tickets/Domain/Entities/Ticket/properties/Project';
import type { TicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';
import { TicketQuery } from '~/Core/Tickets/Domain/Queries/TicketQuery';
import { doneTicketIds, isDone, isEligible } from '~/Core/Tickets/Domain/Services/eligibility';
import { TicketSource } from '~/Core/Tickets/Ports/TicketSource';

const scopeQuery = (project?: Project) =>
  (project === undefined ? TicketQuery : TicketQuery.byProject(project)).build();

const hasBlockerOutside = (tickets: readonly Ticket[]): boolean => {
  const readIds = new Set(tickets.map((ticket) => ticket.id));
  return tickets.some((ticket) => !isDone(ticket) && ticket.blockedBy.some((blocker) => !readIds.has(blocker)));
};

// Blockers resolve against the tickets in scope. A blocker of another Project is
// not in a read narrowed by Project, so only then does the Engine read every
// ticket of the Source to find out whether that blocker is done.
const doneFor = (tickets: readonly Ticket[], project?: Project) =>
  project === undefined || !hasBlockerOutside(tickets)
    ? Effect.succeed(doneTicketIds(tickets))
    : TicketSource.pipe(
        Effect.flatMap((source) => source.getManyBy(TicketQuery.build())),
        Effect.map(doneTicketIds)
      );

const eligibleById = (done: ReadonlySet<TicketId>) => (candidate: Ticket) =>
  TicketSource.pipe(
    Effect.flatMap((source) => source.getOneBy(TicketQuery.byId(candidate.id).build())),
    Effect.option,
    Effect.map(Option.filter((ticket) => isEligible(ticket, done))),
    Effect.map(Result.fromOption(() => candidate))
  );

// The Source returns every ticket in scope in its processing order, done ones
// included, and the core rule picks the Eligible ones. Each candidate is read
// again by identity, so the ticket taken carries its full content and is still
// Eligible when it is taken.
const nextEligibleTicket = (project?: Project) =>
  Effect.gen(function* () {
    const source = yield* TicketSource;
    const tickets = yield* source.getManyBy(scopeQuery(project));
    const done = yield* doneFor(tickets, project);
    const eligible = tickets.filter((ticket) => isEligible(ticket, done));
    return yield* Effect.findFirstFilter(eligible, eligibleById(done));
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
