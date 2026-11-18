import { Effect, Layer } from 'effect';

import { Claim } from '~/Core/Tickets/Domain/Entities/Claim/entity';
import type { TicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';
import { LedgerError } from '~/Core/Tickets/Domain/Exceptions/LedgerError';
import { TicketAlreadyClaimed } from '~/Core/Tickets/Domain/Exceptions/TicketAlreadyClaimed';
import { Ledger } from '~/Core/Tickets/Ports/Ledger';

import { type ClaimHolder, isSameClaim } from './holder';

/**
 * A Ledger held in memory. Every Engine given its layer shares one set of Claims,
 * so several Engines can run against one Ledger. The processes in `running` run
 * on the holder's host; the holder's own process is one of them.
 */
export const makeLedgerMemory = (holder: ClaimHolder = { process: 1, host: 'memory' }) => {
  const claims = new Map<TicketId, Claim>();
  const running = new Set([holder.process]);
  const layer = Layer.succeed(Ledger, {
    claim: (ticket, engine) =>
      Effect.suspend(() => {
        if (claims.has(ticket)) {
          return Effect.fail(new TicketAlreadyClaimed({ ticketId: ticket }));
        }
        const made = new Claim({ ticket, engine, process: holder.process, host: holder.host });
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
    isStale: (held) => Effect.sync(() => held.host === holder.host && !running.has(held.process)),
    releaseStale: (stale) =>
      Effect.sync(() => {
        const held = claims.get(stale.ticket);
        if (held !== undefined && isSameClaim(held, stale)) {
          claims.delete(stale.ticket);
        }
      }),
    releaseAllOf: (engine) =>
      Effect.sync(() => {
        const released = [...claims.values()].filter((held) => held.engine === engine).map((held) => held.ticket);
        for (const ticket of released) {
          claims.delete(ticket);
        }
        return released;
      }),
    read: (tickets) =>
      Effect.sync(
        () =>
          new Map(
            tickets.flatMap((ticket) => {
              const held = claims.get(ticket);
              return held === undefined ? [] : [[ticket, held] as const];
            })
          )
      ),
  });
  return { layer, claims, running };
};
