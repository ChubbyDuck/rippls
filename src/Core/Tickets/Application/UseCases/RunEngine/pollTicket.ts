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
// succeed. Another Engine may have escalated the ticket or made it done and released
// its Claim since the Ledger was read; an Engine records the Escalation or done
// before that release, so both are read again once the Claim is held, and an
// escalated or done ticket is released and skipped. The Claim is then reported to the Source. When the Source cannot
// confirm the Claim, the Engine releases it and takes another ticket.
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
    const escalated = yield* ledger.escalations([ticket.id]);
    const done = yield* ledger.done([ticket.id]);
    if (escalated.has(ticket.id) || done.has(ticket.id)) {
      yield* ledger.release(ticket.id);
      return Result.fail(candidate);
    }
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
    const { tickets, stale, facts } = yield* readTicketScope(project);
    const eligible = tickets.filter((ticket) => isEligible(ticket, facts));
    return yield* Effect.findFirstFilter(eligible, claimIfStillEligible(engine, facts, stale));
  });

export const pollTicket = (engine: EngineId, project?: Project) =>
  claimNextEligibleTicket(engine, project).pipe(
    Effect.tap((found) => (Option.isNone(found) ? Console.log('No tickets are found, continuing') : Effect.void))
  );
