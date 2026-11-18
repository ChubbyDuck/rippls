import { Effect, Option } from 'effect';

import type { Claim } from '~/Core/Tickets/Domain/Entities/Claim/entity';
import type { Escalation } from '~/Core/Tickets/Domain/Entities/Escalation/entity';
import type { Ticket } from '~/Core/Tickets/Domain/Entities/Ticket/entity';
import type { Project } from '~/Core/Tickets/Domain/Entities/Ticket/properties/Project';
import type { TicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';
import { TicketQuery } from '~/Core/Tickets/Domain/Queries/TicketQuery';
import { doneInSourceIds, type EligibilityFacts, isDoneInSource } from '~/Core/Tickets/Domain/Services/eligibility';
import { Ledger } from '~/Core/Tickets/Ports/Ledger';
import { TicketSource } from '~/Core/Tickets/Ports/TicketSource';

/**
 * The tickets in scope, in the Source's processing order, with what the Ledger
 * holds on them: the Claims that hold their ticket, the Stale Claims, and the
 * Escalations. The facts are the ones the eligibility rule needs; their done
 * tickets are the union of the ones the Source sees as done and the ones the
 * Ledger records as done.
 */
export type TicketScope = {
  readonly tickets: readonly Ticket[];
  readonly claims: ReadonlyMap<TicketId, Claim>;
  readonly stale: ReadonlyMap<TicketId, Claim>;
  readonly escalations: ReadonlyMap<TicketId, Escalation>;
  readonly facts: EligibilityFacts;
};

const scopeQuery = (project?: Project) =>
  (project === undefined ? TicketQuery : TicketQuery.byProject(project)).build();

const hasBlockerOutside = (tickets: readonly Ticket[]): boolean => {
  const readIds = new Set(tickets.map((ticket) => ticket.id));
  return tickets.some(
    (ticket) => !isDoneInSource(ticket) && ticket.blockedBy.some((blocker) => !readIds.has(blocker))
  );
};

// Blockers resolve against the tickets in scope. A blocker of another Project is
// not in a read narrowed by Project, so only then does the Engine read every
// ticket of the Source to find out whether its Source sees that blocker as done.
const readForBlockers = (tickets: readonly Ticket[], project?: Project) =>
  project === undefined || !hasBlockerOutside(tickets)
    ? Effect.succeed(tickets)
    : TicketSource.pipe(Effect.flatMap((source) => source.getManyBy(TicketQuery.build())));

// A Source may leave a blocker out of every read of tickets in scope, as the
// Linear Source leaves out a completed Issue, so a blocker that is still not known
// as done is read by its identity, and is done when its Source sees it as done.
const doneByIdentity = (blockers: readonly TicketId[]) =>
  TicketSource.pipe(
    Effect.flatMap((source) =>
      Effect.forEach(blockers, (blocker) =>
        source.getOneBy(TicketQuery.byId(blocker).build()).pipe(
          Effect.option,
          Effect.map((found) => (Option.exists(found, isDoneInSource) ? [blocker] : []))
        )
      )
    ),
    Effect.map((found) => found.flat())
  );

// Done is the union of two facts: the Source sees the ticket as done, or the
// Ledger records it as done. The Ledger is asked about the tickets in scope and
// their blockers.
const doneFor = (tickets: readonly Ticket[], project?: Project) =>
  Effect.gen(function* () {
    const ledger = yield* Ledger;
    const read = yield* readForBlockers(tickets, project);
    const ticketsAndBlockers = new Set(tickets.flatMap((ticket) => [ticket.id, ...ticket.blockedBy]));
    const inLedger = yield* ledger.done([...ticketsAndBlockers]);
    const known = new Set([...doneInSourceIds(read), ...inLedger]);
    const readIds = new Set(read.map((ticket) => ticket.id));
    const unknown = [
      ...new Set(
        tickets
          .filter((ticket) => !known.has(ticket.id))
          .flatMap((ticket) => ticket.blockedBy.filter((blocker) => !known.has(blocker) && !readIds.has(blocker)))
      ),
    ];
    const byIdentity = yield* doneByIdentity(unknown);
    return new Set([...known, ...byIdentity]);
  });

// The Claims on the tickets in scope, split into the ones that hold their ticket
// and the stale ones, which the Engine may replace.
const claimsIn = (tickets: readonly Ticket[]) =>
  Effect.gen(function* () {
    const ledger = yield* Ledger;
    const recorded = yield* ledger.read(tickets.map((ticket) => ticket.id));
    const stale = new Map<TicketId, Claim>();
    const claims = new Map<TicketId, Claim>();
    for (const [id, claim] of recorded) {
      if (yield* ledger.isStale(claim)) {
        stale.set(id, claim);
      } else {
        claims.set(id, claim);
      }
    }
    return { claims, stale };
  });

/**
 * Reads the tickets in scope, narrowed only by Project, and what the Ledger holds
 * on them. A ticket whose only Claim is a Stale Claim is Unclaimed.
 */
export const readTicketScope = (project?: Project) =>
  Effect.gen(function* () {
    const source = yield* TicketSource;
    const ledger = yield* Ledger;
    const tickets = yield* source.getManyBy(scopeQuery(project));
    const { claims, stale } = yield* claimsIn(tickets);
    const escalations = yield* ledger.escalations(tickets.map((ticket) => ticket.id));
    const facts: EligibilityFacts = {
      done: yield* doneFor(tickets, project),
      claimed: new Set(claims.keys()),
      escalated: new Set(escalations.keys()),
    };
    return { tickets, claims, stale, escalations, facts } satisfies TicketScope;
  });
