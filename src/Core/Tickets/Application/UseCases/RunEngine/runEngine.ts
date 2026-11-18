import { Console, Effect, Queue, Stream } from 'effect';

import type { Runner } from '~/Core/Shared/Domain/Entities/Runner';
import { defaultIdleTimeout, defaultPollInterval } from '~/Core/Shared/Domain/EngineConfig';
import { RepositoryRoot } from '~/Core/Shared/Domain/RepositoryRoot';
import type { EngineId } from '~/Core/Shared/Domain/Properties/EngineId';
import type { TicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';
import { Ledger } from '~/Core/Tickets/Ports/Ledger';
import { TicketSource } from '~/Core/Tickets/Ports/TicketSource';

import { processTicket } from '../ProcessTicket/processTicket';
import type { RunEngineCommand } from './command';
import { createEngine } from './createEngine';
import { ensureWorktreesWritable } from './ensureWorktreesWritable';
import { makeIdleClock } from './idleClock';
import { reportUnreadable } from './reportUnreadable';
import { ticketStream } from './ticketStream';

// On exit the Engine releases only the Claims it holds. It reports each release to
// the Source, and removes the record of the Claim only once that report succeeds.
// A record whose release was not reported stays: once the Engine has exited, it is
// a Stale Claim, which a later run replaces. The Claims of other Engines stay in
// place.
const releaseOwnClaim = (ticket: TicketId) =>
  Effect.gen(function* () {
    const ledger = yield* Ledger;
    const source = yield* TicketSource;
    yield* source.report(ticket, 'released');
    yield* ledger.release(ticket);
  }).pipe(
    Effect.catchTags({
      TicketEventNotReported: (error) =>
        Console.error(`Failed to report the release of ticket ${ticket} after the run, so its Claim stays in the Ledger`, error),
      LedgerError: (error) => Console.error(`Failed to release the Claim on ticket ${ticket} after the run`, error),
    })
  );

const releaseOwnClaims = (engine: EngineId) =>
  Ledger.pipe(
    Effect.flatMap((ledger) => ledger.ticketsClaimedBy(engine)),
    Effect.flatMap((tickets) => Effect.forEach(tickets, releaseOwnClaim, { discard: true })),
    Effect.catchTag('LedgerError', (error) => Console.error('Failed to release the Claims of the Engine after the run', error))
  );

export const runEngine = Effect.fn('engine.run')(function* ({
  project,
  limit,
  concurrency = 1,
  idleTimeout = defaultIdleTimeout,
  pollInterval = defaultPollInterval,
  check,
  commit,
}: RunEngineCommand) {
  const root = yield* RepositoryRoot;
  yield* ensureWorktreesWritable(root);
  const engine = yield* createEngine;
  yield* reportUnreadable(project);
  const availableRunners = yield* Queue.unbounded<Runner>();
  yield* Queue.offerAll(
    availableRunners,
    Array.from({ length: concurrency }, () => engine.spawn())
  );
  const clock = yield* makeIdleClock(idleTimeout);
  const tickets = ticketStream(engine.id, project, clock, pollInterval);
  const limitedTickets = limit === undefined ? tickets : tickets.pipe(Stream.take(limit));
  yield* Effect.annotateCurrentSpan({
    'engine.id': engine.id,
    'engine.concurrency': concurrency,
    'engine.limit': limit ?? -1,
  });
  yield* limitedTickets.pipe(
    Stream.mapEffect(
      (ticket) =>
        Effect.acquireUseRelease(
          Queue.take(availableRunners),
          (runner) =>
            Effect.gen(function* () {
              yield* Console.log(`${ticket.label} is taken into the runner ${runner.id}`);
              yield* processTicket({ ticket, runnerId: runner.id, repositoryRoot: root, check, commit });
            }).pipe(Effect.ensuring(clock.onDone)),
          (runner) => Queue.offer(availableRunners, runner).pipe(Effect.asVoid)
        ),
      { concurrency, unordered: true }
    ),
    Stream.runDrain,
    Effect.raceFirst(clock.awaitTimeout),
    Effect.catchTag('EngineIdleTimeout', (error) => Console.log(error.message)),
    Effect.ensuring(releaseOwnClaims(engine.id))
  );
});
