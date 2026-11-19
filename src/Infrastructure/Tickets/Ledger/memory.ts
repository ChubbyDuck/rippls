import { Effect, Layer } from 'effect';

import type { EngineId } from '~/Core/Shared/Domain/Properties/EngineId';
import { Claim } from '~/Core/Tickets/Domain/Entities/Claim/entity';
import { Escalation } from '~/Core/Tickets/Domain/Entities/Escalation/entity';
import type { TicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';
import { LedgerError } from '~/Core/Tickets/Domain/Exceptions/LedgerError';
import { TicketAlreadyClaimed } from '~/Core/Tickets/Domain/Exceptions/TicketAlreadyClaimed';
import { Ledger } from '~/Core/Tickets/Ports/Ledger';

import { type ClaimHolder, isStaleFor } from './holder';

/**
 * A Ledger held in memory. Every Engine given its layer shares one set of Claims
 * and Escalations, so several Engines can run against one Ledger. The processes
 * in `running` run on the holder's host; the holder's own process is one of them.
 * A cleared Escalation moves to `cleared`, which keeps its attempt count. `done`
 * holds the tickets recorded as done.
 */
export const makeLedgerMemory = (holder: ClaimHolder = { process: 1, host: 'memory' }) => {
  const claims = new Map<TicketId, Claim>();
  const running = new Set([holder.process]);
  const escalated = new Map<TicketId, Escalation>();
  const cleared = new Map<TicketId, Escalation>();
  const done = new Set<TicketId>();
  const claimOf = (ticket: TicketId, engine: EngineId) =>
    new Claim({ ticket, engine, process: holder.process, host: holder.host });
  const pick = <A>(records: ReadonlyMap<TicketId, A>, tickets: readonly TicketId[]): ReadonlyMap<TicketId, A> =>
    new Map(
      tickets.flatMap((ticket) => {
        const record = records.get(ticket);
        return record === undefined ? [] : [[ticket, record] as const];
      })
    );
  const layer = Layer.succeed(Ledger, {
    claim: (ticket, engine) =>
      Effect.suspend(() => {
        if (claims.has(ticket)) {
          return Effect.fail(new TicketAlreadyClaimed({ ticketId: ticket }));
        }
        const made = claimOf(ticket, engine);
        claims.set(ticket, made);
        return Effect.succeed(made);
      }),
    assignRunner: (ticket, runner) =>
      Effect.suspend(() => {
        const held = claims.get(ticket);
        if (held === undefined) {
          return Effect.fail(new LedgerError({ cause: `The Ledger holds no Claim on ${ticket}` }));
        }
        claims.set(ticket, held.withRunner(runner));
        return Effect.void;
      }),
    release: (ticket) =>
      Effect.sync(() => {
        claims.delete(ticket);
      }),
    isStale: isStaleFor(holder, (process) => Effect.sync(() => running.has(process))),
    replaceStale: (stale, engine) =>
      Effect.sync(() => {
        const held = claims.get(stale.ticket);
        if (held?.isSameClaim(stale) !== true) {
          return false;
        }
        claims.set(stale.ticket, claimOf(stale.ticket, engine));
        return true;
      }),
    ticketsClaimedBy: (engine) =>
      Effect.sync(() => [...claims.values()].filter((held) => held.engine === engine).map((held) => held.ticket)),
    read: (tickets) => Effect.sync(() => pick(claims, tickets)),
    escalate: (ticket, { reason, worktree }) =>
      Effect.sync(() => {
        const attempts = ((escalated.get(ticket) ?? cleared.get(ticket))?.attempts ?? 0) + 1;
        const escalation = new Escalation({ ticket, reason, attempts, worktree });
        escalated.set(ticket, escalation);
        cleared.delete(ticket);
        return escalation;
      }),
    clearEscalation: (ticket) =>
      Effect.sync(() => {
        const held = escalated.get(ticket);
        if (held !== undefined) {
          cleared.set(ticket, held);
          escalated.delete(ticket);
        }
      }),
    escalations: (tickets) => Effect.sync(() => pick(escalated, tickets)),
    recordDone: (ticket) =>
      Effect.sync(() => {
        done.add(ticket);
      }),
    done: (tickets) => Effect.sync(() => new Set(tickets.filter((ticket) => done.has(ticket)))),
  });
  return { layer, claims, running, escalated, cleared, done };
};
