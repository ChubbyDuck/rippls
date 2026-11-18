import { Console, Effect, Option, Result } from 'effect';

import type { EngineId } from '~/Core/Shared/Domain/Properties/EngineId';
import type { Ticket } from '~/Core/Tickets/Domain/Entities/Ticket/entity';
import type { Project } from '~/Core/Tickets/Domain/Entities/Ticket/properties/Project';
import { TicketQuery } from '~/Core/Tickets/Domain/Queries/TicketQuery';
import { doneTicketIds, type EligibilityFacts, isDone, isEligible } from '~/Core/Tickets/Domain/Services/eligibility';
import { Ledger } from '~/Core/Tickets/Ports/Ledger';
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

const claimedIn = (tickets: readonly Ticket[]) =>
  Ledger.pipe(
    Effect.flatMap((ledger) => ledger.read(tickets.map((ticket) => ticket.id))),
    Effect.map((claims): ReadonlySet<Ticket['id']> => new Set(claims.keys()))
  );

// Each candidate is read again by identity, so the ticket taken carries its full
// content and is still Eligible when it is taken. The Claim is then created in the
// Ledger, where only one caller can succeed, and reported to the Source. When the
// Source cannot confirm the Claim, the Engine releases it and takes another ticket.
const claimFirstOf = (engine: EngineId, facts: EligibilityFacts) => (candidate: Ticket) =>
  Effect.gen(function* () {
    const source = yield* TicketSource;
    const ledger = yield* Ledger;
    const fresh = yield* source.getOneBy(TicketQuery.byId(candidate.id).build()).pipe(Effect.option);
    if (Option.isNone(fresh) || !isEligible(fresh.value, facts)) {
      return Result.fail(candidate);
    }
    const ticket = fresh.value;
    const claimed = yield* ledger.claim(ticket.id, engine).pipe(
      Effect.as(true),
      Effect.catchTag('TicketAlreadyClaimed', () => Effect.succeed(false))
    );
    if (!claimed) {
      return Result.fail(candidate);
    }
    const reported = yield* source.report(ticket.id, 'claimed').pipe(
      Effect.as(true),
      Effect.catchTag('TicketEventNotReported', () =>
        Console.log(`${ticket.label} could not be claimed on the Source, taking another ticket`).pipe(
          Effect.andThen(ledger.release(ticket.id)),
          Effect.as(false)
        )
      )
    );
    if (!reported) {
      return Result.fail(candidate);
    }
    yield* Console.log(`${ticket.label} is claimed`);
    return Result.succeed(ticket);
  });

// The Source returns every ticket in scope in its processing order, done ones
// included, the Ledger holds the Claims, and the core rule picks the Eligible
// tickets. The Engine claims the first one it can.
const claimNextEligibleTicket = (engine: EngineId, project?: Project) =>
  Effect.gen(function* () {
    const source = yield* TicketSource;
    const tickets = yield* source.getManyBy(scopeQuery(project));
    const facts = { done: yield* doneFor(tickets, project), claimed: yield* claimedIn(tickets) };
    const eligible = tickets.filter((ticket) => isEligible(ticket, facts));
    return yield* Effect.findFirstFilter(eligible, claimFirstOf(engine, facts));
  });

export const pollTicket = (engine: EngineId, project?: Project) =>
  claimNextEligibleTicket(engine, project).pipe(
    Effect.tap((found) => (Option.isNone(found) ? Console.log('No tickets are found, continuing') : Effect.void))
  );

const _pollTicketTraced = (engine: EngineId, project?: Project) =>
  Effect.gen(function* () {
    const ticket = yield* claimNextEligibleTicket(engine, project).pipe(
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
