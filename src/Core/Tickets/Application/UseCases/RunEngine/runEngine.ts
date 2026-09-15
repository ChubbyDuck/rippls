import { Console, Effect, Queue, Stream } from 'effect';

import type { Runner } from '~/Core/Shared/Domain/Entities/Runner';
import { defaultIdleTimeout, defaultPollInterval } from '~/Core/Shared/Domain/EngineConfig';
import { RepositoryRoot } from '~/Core/Shared/Domain/RepositoryRoot';
import type { Project } from '~/Core/Tickets/Domain/Entities/Ticket/properties/Project';
import { TicketQuery } from '~/Core/Tickets/Domain/Queries/TicketQuery';
import { TicketSource } from '~/Core/Tickets/Ports/TicketSource';

import { processTicket } from '../ProcessTicket/processTicket';
import type { RunEngineCommand } from './command';
import { createEngine } from './createEngine';
import { ensureWorktreesWritable } from './ensureWorktreesWritable';
import { makeIdleClock } from './idleClock';
import { ticketStream } from './ticketStream';

const releaseTakenTickets = (project?: Project) =>
  Effect.gen(function* () {
    const source = yield* TicketSource;
    const taken = project === undefined ? TicketQuery.claimed() : TicketQuery.claimed().byProject(project);
    const stuck = yield* source.getManyBy(taken.build());
    yield* Effect.forEach(
      stuck,
      (ticket) =>
        source
          .save(ticket.release())
          .pipe(Effect.catch((error) => Console.error(`Failed to release ticket ${ticket.id} after the run`, error))),
      { discard: true }
    );
  });

export const runEngine = Effect.fn('engine.run')(function* ({
  project,
  limit,
  concurrency = 1,
  idleTimeout = defaultIdleTimeout,
  pollInterval = defaultPollInterval,
}: RunEngineCommand) {
  const root = yield* RepositoryRoot;
  yield* ensureWorktreesWritable(root);
  const engine = yield* createEngine;
  const availableRunners = yield* Queue.unbounded<Runner>();
  yield* Queue.offerAll(
    availableRunners,
    Array.from({ length: concurrency }, () => engine.spawn())
  );
  const clock = yield* makeIdleClock(idleTimeout);
  const tickets = ticketStream(project, clock, pollInterval);
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
              yield* processTicket({ ticket, runnerId: runner.id, repositoryRoot: root });
            }).pipe(Effect.ensuring(clock.onDone)),
          (runner) => Queue.offer(availableRunners, runner).pipe(Effect.asVoid)
        ),
      { concurrency, unordered: true }
    ),
    Stream.runDrain,
    Effect.raceFirst(clock.awaitTimeout),
    Effect.catchTag('EngineIdleTimeout', (error) => Console.log(error.message)),
    Effect.ensuring(releaseTakenTickets(project))
  );
});
