import { Console, Effect, Option, Result } from 'effect';

import type { EngineId } from '~/Core/Shared/Domain/Properties/EngineId';
import { readTicketScope } from '~/Core/Tickets/Application/Services/ticketScope';
import type { Claim } from '~/Core/Tickets/Domain/Entities/Claim/entity';
import type { Ticket } from '~/Core/Tickets/Domain/Entities/Ticket/entity';
import type { Project } from '~/Core/Tickets/Domain/Entities/Ticket/properties/Project';
import type { TicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';
import { TicketQuery } from '~/Core/Tickets/Domain/Queries/TicketQuery';
import { type EligibilityFacts, isEligible } from '~/Core/Tickets/Domain/Services/eligibility';
import { Ledger } from '~/Core/Tickets/Ports/Ledger';
import { TicketSource } from '~/Core/Tickets/Ports/TicketSource';

// The release of a Stale Claim is reported to the Source by the Engine that won the
// removal of its record and holds the new Claim, so a late release never undoes a
// Claim of another Engine. Whether the report succeeded is returned: a failure does
// not stop the claim.
const reportStaleReleased = (ticket: Ticket) =>
  TicketSource.pipe(
    Effect.flatMap((source) => source.report(ticket.id, 'released')),
    Effect.as(true),
    Effect.catchTag('TicketEventNotReported', () =>
      Console.log(`${ticket.label} could not have its stale Claim released on the Source`).pipe(Effect.as(false))
    )
  );

// When the Source cannot confirm the Claim, the Engine releases it and takes another
// ticket. After a release the Source was not told of, the Claim stays until the
// Engine exits, which reports the release again, so the Source is never left
// claimed with no record in the Ledger.
const onClaimNotReported = (ticket: Ticket, releaseReported: boolean) =>
  releaseReported
    ? Console.log(`${ticket.label} could not be claimed on the Source, taking another ticket`).pipe(
        Effect.andThen(Ledger.pipe(Effect.flatMap((ledger) => ledger.release(ticket.id))))
      )
    : Console.log(
        `${ticket.label} could not be claimed on the Source, so its Claim stays until the Engine exits, taking another ticket`
      );

// Each candidate is read again by identity, so the ticket taken carries its full
// content and is still Eligible when it is taken. A stale Claim on it is replaced:
// its record is removed, and only the Engine that wins that removal goes on. The
// Claim is then created in the Ledger, where only one caller can succeed, and the
// release of the stale Claim is reported to the Source. Another Engine may have
// escalated the ticket or made it done and released its Claim since the Ledger was
// read; an Engine records the Escalation or done before that release, so both are
// read again once the Claim is held, and an escalated or done ticket is released
// and skipped. The Claim is then reported to the Source.
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
      yield* Console.log(`${ticket.label} has a stale Claim of ${staleClaim.engine}, replacing it`);
      if (!(yield* ledger.releaseStale(staleClaim))) {
        yield* Console.log(`${ticket.label} had its stale Claim replaced by another Engine, taking another ticket`);
        return Result.fail(candidate);
      }
    }
    yield* ledger.claim(ticket.id, engine);
    const releaseReported = staleClaim === undefined ? true : yield* reportStaleReleased(ticket);
    const escalated = yield* ledger.escalations([ticket.id]);
    const done = yield* ledger.done([ticket.id]);
    if (escalated.has(ticket.id) || done.has(ticket.id)) {
      yield* ledger.release(ticket.id);
      return Result.fail(candidate);
    }
    yield* source.report(ticket.id, 'claimed').pipe(Effect.tapError(() => onClaimNotReported(ticket, releaseReported)));
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
