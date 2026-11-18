import { Console, Effect, Option, Result } from 'effect';

import type { EngineId } from '~/Core/Shared/Domain/Properties/EngineId';
import type { Claim } from '~/Core/Tickets/Domain/Entities/Claim/entity';
import type { Ticket } from '~/Core/Tickets/Domain/Entities/Ticket/entity';
import type { Project } from '~/Core/Tickets/Domain/Entities/Ticket/properties/Project';
import type { TicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';
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

// The Claims on the tickets in scope, split into the ones that hold their ticket
// and the stale ones, which the Engine may replace.
const claimsIn = (tickets: readonly Ticket[]) =>
  Effect.gen(function* () {
    const ledger = yield* Ledger;
    const claims = yield* ledger.read(tickets.map((ticket) => ticket.id));
    const stale = new Map<TicketId, Claim>();
    const claimed = new Set<TicketId>();
    for (const [id, claim] of claims) {
      if (yield* ledger.isStale(claim)) {
        stale.set(id, claim);
      } else {
        claimed.add(id);
      }
    }
    return { claimed, stale };
  });

// A stale Claim is replaced: its release is reported to the Source, then its record
// is removed, and the ticket can be claimed in the normal way.
const replaceStale = (ticket: Ticket, stale: Claim) =>
  Effect.gen(function* () {
    const source = yield* TicketSource;
    const ledger = yield* Ledger;
    yield* Console.log(`${ticket.label} has a stale Claim of ${stale.engine}, replacing it`);
    yield* source.report(ticket.id, 'released');
    yield* ledger.releaseStale(stale);
  });

// Each candidate is read again by identity, so the ticket taken carries its full
// content and is still Eligible when it is taken. A stale Claim on it is replaced
// first. The Claim is then created in the Ledger, where only one caller can
// succeed, and reported to the Source. When the Source cannot confirm the Claim,
// the Engine releases it and takes another ticket.
const claimIfStillEligible =
  (engine: EngineId, facts: EligibilityFacts, stale: ReadonlyMap<TicketId, Claim>) => (candidate: Ticket) =>
  Effect.gen(function* () {
    const source = yield* TicketSource;
    const ledger = yield* Ledger;
    const fresh = yield* source.getOneBy(TicketQuery.byId(candidate.id).build()).pipe(Effect.option);
    if (Option.isNone(fresh) || !isEligible(fresh.value, facts)) {
      return Result.fail(candidate);
    }
    const ticket = fresh.value;
    const staleClaim = stale.get(ticket.id);
    if (staleClaim !== undefined) {
      yield* replaceStale(ticket, staleClaim);
    }
    yield* ledger.claim(ticket.id, engine);
    yield* source.report(ticket.id, 'claimed').pipe(
      Effect.tapError(() =>
        Console.log(`${ticket.label} could not be claimed on the Source, taking another ticket`).pipe(
          Effect.andThen(ledger.release(ticket.id))
        )
      )
    );
    yield* Console.log(`${ticket.label} is claimed`);
    return Result.succeed(ticket);
  }).pipe(
    Effect.catchTags({
      TicketAlreadyClaimed: () => Effect.succeed(Result.fail(candidate)),
      TicketEventNotReported: () => Effect.succeed(Result.fail(candidate)),
    })
  );

// The Source returns every ticket in scope in its processing order, done ones
// included, the Ledger holds the Claims and Escalations, and the core rule picks
// the Eligible tickets. A ticket whose only Claim is a Stale Claim is Unclaimed,
// and the Engine replaces that Claim when it takes the ticket. The Engine claims
// the first one it can.
const claimNextEligibleTicket = (engine: EngineId, project?: Project) =>
  Effect.gen(function* () {
    const source = yield* TicketSource;
    const tickets = yield* source.getManyBy(scopeQuery(project));
    const { claimed, stale } = yield* claimsIn(tickets);
    const ledger = yield* Ledger;
    const escalations = yield* ledger.escalations(tickets.map((ticket) => ticket.id));
    const facts = { done: yield* doneFor(tickets, project), claimed, escalated: new Set(escalations.keys()) };
    const eligible = tickets.filter((ticket) => isEligible(ticket, facts));
    return yield* Effect.findFirstFilter(eligible, claimIfStillEligible(engine, facts, stale));
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
