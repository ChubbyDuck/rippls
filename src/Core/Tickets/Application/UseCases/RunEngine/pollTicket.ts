import { Console, Effect, Option, Result } from 'effect';

import type { EngineId } from '~/Core/Shared/Domain/Properties/EngineId';
import { endSaga } from '~/Core/Tickets/Application/Services/endSaga';
import { readTicketScope } from '~/Core/Tickets/Application/Services/ticketScope';
import type { Claim } from '~/Core/Tickets/Domain/Entities/Claim/entity';
import type { Ticket } from '~/Core/Tickets/Domain/Entities/Ticket/entity';
import type { Project } from '~/Core/Tickets/Domain/Entities/Ticket/properties/Project';
import type { TicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';
import { type EligibilityFacts, isEligible } from '~/Core/Tickets/Domain/Services/eligibility';
import { Ledger } from '~/Core/Tickets/Ports/Ledger';
import { TicketSource } from '~/Core/Tickets/Ports/TicketSource';

// A Stale Claim is replaced in the Ledger in one operation, which turns it into the
// Claim of this Engine, so the ticket never has no record. Of several Engines that
// replace one Stale Claim, only one wins. Whether this Engine won is returned.
const replaceStale = (ticket: Ticket, stale: Claim, engine: EngineId) =>
  Effect.gen(function* () {
    const ledger = yield* Ledger;
    yield* Console.log(`${ticket.label} has a Stale Claim of ${stale.engine}, replacing it`);
    const won = yield* ledger.replaceStale(stale, engine);
    if (!won) {
      yield* Console.log(`${ticket.label} had its Stale Claim replaced by another Engine, taking another ticket`);
    }
    return won;
  });

// The release of a Stale Claim is reported to the Source by the Engine that won its
// replacement and holds the new Claim, so a late release never undoes a Claim of
// another Engine. Whether the report succeeded is returned: a failure does not stop
// the claim.
const reportStaleReleased = (ticket: Ticket) =>
  TicketSource.pipe(
    Effect.flatMap((source) => source.report(ticket.id, 'released')),
    Effect.as(true),
    Effect.catchTag('TicketEventNotReported', () =>
      Console.log(`${ticket.label} could not have its Stale Claim released on the Source`).pipe(Effect.as(false))
    )
  );

// The Engine gives up the Claim it has just made on a ticket that another Engine
// escalated or made done, and takes another ticket. The record is removed, unless the
// release of the Stale Claim it replaced was not reported: the Source may then still
// show the ticket claimed, so the Claim stays until the Engine exits, which reports
// the release again, and the Source is never left claimed with no record in the
// Ledger.
const giveUpClaim = (ticket: Ticket, staleReleaseReported: boolean) =>
  Effect.gen(function* () {
    const why = `${ticket.label} was escalated or done by another Engine`;
    if (!staleReleaseReported) {
      yield* Console.log(`${why}, so its Claim stays until the Engine exits, taking another ticket`);
      return;
    }
    yield* Console.log(`${why}, taking another ticket`);
    const ledger = yield* Ledger;
    yield* ledger.release(ticket.id);
  });

// A claimed report that fails may have written to the Source, so the Engine keeps
// its Claim in the Ledger and takes another ticket: nothing removes the record here.
// On exit it reports released, which undoes what the report wrote.
const logClaimKept = (ticket: Ticket) =>
  Console.log(
    `${ticket.label} could not be claimed on the Source, so its Claim stays until the Engine exits, taking another ticket`
  );

// Each candidate is read again by identity, so the ticket taken carries its full
// content and is still Eligible when it is taken. A Stale Claim on it is replaced
// first, and the Engine that replaced it reports its release to the Source.
// Otherwise the Claim is created in the Ledger, where only one caller can succeed.
// Another Engine may have escalated the ticket or made it done and released its
// Claim since the Ledger was read; an Engine records the Escalation or done before
// that release, so both are read again once the Claim is held, and the Claim on an
// escalated or done ticket is given up. The Claim is then reported to the Source;
// when the Source cannot confirm it, the ticket is not taken, and the Claim stays
// until the Engine exits.
const claimIfStillEligible =
  (engine: EngineId, facts: EligibilityFacts, stale: ReadonlyMap<TicketId, Claim>) => (candidate: Ticket) =>
  Effect.gen(function* () {
    const source = yield* TicketSource;
    const ledger = yield* Ledger;
    const fresh = yield* source.getOneBy({ id: candidate.id }).pipe(Effect.option);
    if (Option.isNone(fresh) || !isEligible(fresh.value, facts)) {
      return Result.fail(candidate);
    }
    const ticket = fresh.value;
    const staleClaim = stale.get(ticket.id);
    let staleReleaseReported = true;
    if (staleClaim === undefined) {
      yield* ledger.claim(ticket.id, engine);
    } else {
      if (!(yield* replaceStale(ticket, staleClaim, engine))) {
        return Result.fail(candidate);
      }
      staleReleaseReported = yield* reportStaleReleased(ticket);
    }
    const escalated = yield* ledger.escalations([ticket.id]);
    const done = yield* ledger.done([ticket.id]);
    if (escalated.has(ticket.id) || done.has(ticket.id)) {
      yield* giveUpClaim(ticket, staleReleaseReported);
      return Result.fail(candidate);
    }
    yield* source.report(ticket.id, 'claimed').pipe(Effect.tapError(() => logClaimKept(ticket)));
    yield* Console.log(`${ticket.label} is claimed`);
    return Result.succeed(ticket);
  }).pipe(
    Effect.catchTags({
      TicketAlreadyClaimed: () => Effect.succeed(Result.fail(candidate)),
      TicketEventNotReported: () => Effect.succeed(Result.fail(candidate)),
    })
  );

// A Stale Claim on a ticket that is escalated or done is the record of a stopped
// saga: its Engine could not report the end state. The Engine that wins the
// replacement ends the saga with the report that the Ledger shows, and removes the
// record once the Source accepts it. It never takes the ticket. When the report
// fails, its Claim stays until the Engine exits, which reports again.
const finishStoppedSagas = (
  engine: EngineId,
  tickets: readonly Ticket[],
  stale: ReadonlyMap<TicketId, Claim>,
  facts: EligibilityFacts
) =>
  Effect.forEach(
    tickets.filter((ticket) => stale.has(ticket.id) && (facts.done.has(ticket.id) || facts.escalated.has(ticket.id))),
    (ticket) =>
      Effect.gen(function* () {
        const staleClaim = stale.get(ticket.id);
        if (staleClaim === undefined || !(yield* replaceStale(ticket, staleClaim, engine))) {
          return;
        }
        yield* endSaga(ticket.id).pipe(
          Effect.andThen(Console.log(`${ticket.label} has its stopped saga finished, not taking it`)),
          Effect.catchTag('TicketEventNotReported', (error) =>
            Console.error(`${ticket.label} could not have its stopped saga finished on the Source, so its Claim stays`, error)
          )
        );
      }),
    { discard: true }
  );

// The Source returns every ticket in scope in its processing order, done ones
// included, the Ledger holds the Claims and Escalations, and the core rule picks
// the Eligible tickets. A ticket whose only Claim is a Stale Claim is Unclaimed,
// and the Engine replaces that Claim when it takes the ticket. The Engine claims
// the first one it can.
const claimNextEligibleTicket = (engine: EngineId, project?: Project) =>
  Effect.gen(function* () {
    const { tickets, stale, facts } = yield* readTicketScope(project);
    yield* finishStoppedSagas(engine, tickets, stale, facts);
    const eligible = tickets.filter((ticket) => isEligible(ticket, facts));
    return yield* Effect.findFirstFilter(eligible, claimIfStillEligible(engine, facts, stale));
  });

export const pollTicket = (engine: EngineId, project?: Project) =>
  claimNextEligibleTicket(engine, project).pipe(
    Effect.tap((found) => (Option.isNone(found) ? Console.log('No tickets are found, continuing') : Effect.void))
  );
