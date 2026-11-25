import { Console, Effect, Queue, Ref, Stream } from 'effect';

import type { Runner } from '~/Core/Shared/Domain/Entities/Runner';
import { defaultPollInterval, defaultWorkspace } from '~/Core/Shared/Domain/EngineConfig';
import { RepositoryRoot } from '~/Core/Shared/Domain/RepositoryRoot';
import type { EngineId } from '~/Core/Shared/Domain/Properties/EngineId';
import type { TicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';
import { endSaga } from '~/Core/Tickets/Application/Services/endSaga';
import { ConcurrencyNotInPlace } from '~/Core/Tickets/Domain/Exceptions/ConcurrencyNotInPlace';
import { Ledger } from '~/Core/Tickets/Ports/Ledger';

import { processTicket } from '../ProcessTicket/processTicket';
import type { RunEngineCommand } from './command';
import { createEngine } from './createEngine';
import { ensureWorktreesWritable } from './ensureWorktreesWritable';
import { makeIdleClock } from './idleClock';
import { reportHeld } from './reportHeld';
import { reportUnreadable } from './reportUnreadable';
import { ticketStream } from './ticketStream';

// On exit the Engine ends the saga of the Claims it holds, and only of those. The
// end state it reports follows the Ledger: done, escalated, or released. It removes
// the record of a Claim only once that report succeeds. A record whose report
// failed stays: once the Engine has exited, it is a Stale Claim, which a later run
// finishes. The Claims of other Engines stay in place.
const endOwnClaim = (ticket: TicketId) =>
  endSaga(ticket).pipe(
    Effect.catchTags({
      TicketEventNotReported: (error) =>
        Console.error(`Failed to report the end of ticket ${ticket} after the run, so its Claim stays in the Ledger`, error),
      LedgerError: (error) => Console.error(`Failed to end the Claim on ticket ${ticket} after the run`, error),
    })
  );

const endOwnClaims = (engine: EngineId) =>
  Ledger.pipe(
    Effect.flatMap((ledger) => ledger.ticketsClaimedBy(engine)),
    Effect.flatMap((tickets) => Effect.forEach(tickets, endOwnClaim, { discard: true })),
    Effect.catchTag('LedgerError', (error) => Console.error('Failed to release the Claims of the Engine after the run', error))
  );

export const runEngine = Effect.fn('engine.run')(function* ({
  project,
  limit,
  concurrency = 1,
  workspace = defaultWorkspace,
  watch = false,
  idleTimeout,
  pollInterval = defaultPollInterval,
  check,
  commit,
}: RunEngineCommand) {
  // In place, every Runner would share the Repository Root, so the run fails
  // before it touches anything. In place needs no worktrees directory.
  if (workspace === 'in-place' && concurrency > 1) {
    return yield* new ConcurrencyNotInPlace({ concurrency });
  }
  const root = yield* RepositoryRoot;
  if (workspace === 'worktree') {
    yield* ensureWorktreesWritable(root);
  }
  const engine = yield* createEngine;
  yield* reportUnreadable(project);
  const availableRunners = yield* Queue.unbounded<Runner>();
  yield* Queue.offerAll(
    availableRunners,
    Array.from({ length: concurrency }, () => engine.spawn())
  );
  // A Watch halts only after an idle timeout that is set. A Drain ends as soon as
  // the Engine is Idle, so no idle timeout applies to it.
  const clock = yield* makeIdleClock(watch ? idleTimeout : undefined);
  const endedIdle = yield* Ref.make(false);
  const onIdle = Console.log('The Engine is Idle, so the Drain ends').pipe(Effect.andThen(Ref.set(endedIdle, true)));
  const tickets = ticketStream(engine.id, { project, clock, pollInterval, watch, onIdle });
  const limitedTickets = limit === undefined ? tickets : tickets.pipe(Stream.take(limit));
  yield* Effect.annotateCurrentSpan({
    'engine.id': engine.id,
    'engine.concurrency': concurrency,
    'engine.limit': limit ?? -1,
    'engine.watch': watch,
  });
  yield* limitedTickets.pipe(
    Stream.mapEffect(
      (ticket) =>
        Effect.acquireUseRelease(
          Queue.take(availableRunners),
          (runner) =>
            Effect.gen(function* () {
              yield* Console.log(`${ticket.label} is taken into the runner ${runner.id}`);
              yield* processTicket({ ticket, runnerId: runner.id, check, commit });
            }).pipe(Effect.ensuring(clock.onDone)),
          (runner) => Queue.offer(availableRunners, runner).pipe(Effect.asVoid)
        ),
      { concurrency, unordered: true }
    ),
    Stream.runDrain,
    Effect.raceFirst(clock.awaitTimeout),
    Effect.catchTag('EngineIdleTimeout', (error) => Console.log(error.message)),
    Effect.ensuring(endOwnClaims(engine.id))
  );
  // Once its own Claims have ended, a Drain that ended Idle lists what it held back.
  if (yield* Ref.get(endedIdle)) {
    yield* reportHeld(project);
  }
});
