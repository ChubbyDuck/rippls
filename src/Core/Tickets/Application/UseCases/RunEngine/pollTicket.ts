import { Console, Effect, Option, Result } from 'effect';

import type { EngineId } from '~/Core/Shared/Domain/Properties/EngineId';
import { readTicketScope } from '~/Core/Tickets/Application/Services/ticketScope';
import type { Claim } from '~/Core/Tickets/Domain/Entities/Claim/entity';
import type { Ticket } from '~/Core/Tickets/Domain/Entities/Ticket/entity';
import type { Project } from '~/Core/Tickets/Domain/Entities/Ticket/properties/Project';
import type { TicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';
import { type EligibilityFacts, isEligible } from '~/Core/Tickets/Domain/Services/eligibility';
import { Ledger } from '~/Core/Tickets/Ports/Ledger';
import { TicketSource } from '~/Core/Tickets/Ports/TicketSource';

// A Stale Claim is replaced in the Ledger: its record is removed, and only the
// Engine that wins that removal makes the new Claim. Nothing interrupts the two
// steps, so a stopped poll never leaves the ticket with neither record. Whether this
// Engine won is returned.
const replaceStale = (ticket: Ticket, stale: Claim, engine: EngineId) =>
  Effect.gen(function* () {
    const ledger = yield* Ledger;
    yield* Console.log(`${ticket.label} has a Stale Claim of ${stale.engine}, replacing it`);
    if (!(yield* ledger.releaseStale(stale))) {
      yield* Console.log(`${ticket.label} had its Stale Claim replaced by another Engine, taking another ticket`);
      return false;
    }
    yield* ledger.claim(ticket.id, engine);
    return true;
  }).pipe(Effect.uninterruptible);

// The release of a Stale Claim is reported to the Source by the Engine that won the
// removal of its record and holds the new Claim, so a late release never undoes a
// Claim of another Engine. Whether the report succeeded is returned: a failure does
// not stop the claim.
const reportStaleReleased = (ticket: Ticket) =>
  TicketSource.pipe(
    Effect.flatMap((source) => source.report(ticket.id, 'released')),
    Effect.as(true),
    Effect.catchTag('TicketEventNotReported', () =>
      Console.log(`${ticket.label} could not have its Stale Claim released on the Source`).pipe(Effect.as(false))
    )
  );

// The Engine gives up the Claim it has just made on a ticket it does not take, and
// takes another ticket. The record is removed, unless the release of the Stale Claim
// it replaced was not reported: the Source may then still show the ticket claimed,
// so the Claim stays until the Engine exits, which reports the release again, and
// the Source is never left claimed with no record in the Ledger.
const giveUpClaim = (ticket: Ticket, staleReleaseReported: boolean, why: string) =>
  Effect.gen(function* () {
    if (!staleReleaseReported) {
      yield* Console.log(`${ticket.label} ${why}, so its Claim stays until the Engine exits, taking another ticket`);
      return;
    }
    yield* Console.log(`${ticket.label} ${why}, taking another ticket`);
    const ledger = yield* Ledger;
    yield* ledger.release(ticket.id);
  });

// Each candidate is read again by identity, so the ticket taken carries its full
// content and is still Eligible when it is taken. A Stale Claim on it is replaced
// first, and the Engine that replaced it reports its release to the Source.
// Otherwise the Claim is created in the Ledger, where only one caller can succeed.
// Another Engine may have escalated the ticket or made it done and released its
// Claim since the Ledger was read; an Engine records the Escalation or done before
// that release, so both are read again once the Claim is held, and the Claim on an
// escalated or done ticket is given up. The Claim is then reported to the Source;
// when the Source cannot confirm it, the Claim is given up too.
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
      yield* giveUpClaim(ticket, staleReleaseReported, 'was escalated or done by another Engine');
      return Result.fail(candidate);
    }
    yield* source
      .report(ticket.id, 'claimed')
      .pipe(Effect.tapError(() => giveUpClaim(ticket, staleReleaseReported, 'could not be claimed on the Source')));
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
    const { tickets, stale, facts } = yield* readTicketScope(project);
    const eligible = tickets.filter((ticket) => isEligible(ticket, facts));
    return yield* Effect.findFirstFilter(eligible, claimIfStillEligible(engine, facts, stale));
  });

export const pollTicket = (engine: EngineId, project?: Project) =>
  claimNextEligibleTicket(engine, project).pipe(
    Effect.tap((found) => (Option.isNone(found) ? Console.log('No tickets are found, continuing') : Effect.void))
  );
