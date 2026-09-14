import { Console, Effect, Queue, Stream } from 'effect';

import type { Runner } from '~/Core/Shared/Domain/Entities/Runner';
import { defaultIdleTimeout, defaultPollInterval } from '~/Core/Shared/Domain/HarnessConfig';
import { RepositoryRoot } from '~/Core/Shared/Domain/RepositoryRoot';
import type { Project } from '~/Core/Tickets/Domain/Entities/Ticket/properties/Project';
import { TicketQuery } from '~/Core/Tickets/Domain/Queries/TicketQuery';
import { TicketRepository } from '~/Core/Tickets/Ports/TicketRepository';

import { processTicket } from '../ProcessTicket/processTicket';
import type { RunHarnessCommand } from './command';
import { createHarness } from './createHarness';
import { ensureWorktreesWritable } from './ensureWorktreesWritable';
import { makeIdleClock } from './idleClock';
import { ticketStream } from './ticketStream';

const releaseTakenTickets = (project?: Project) =>
  Effect.gen(function* () {
    const repo = yield* TicketRepository;
    const taken = project === undefined ? TicketQuery.claimed() : TicketQuery.claimed().byProject(project);
    const stuck = yield* repo.getManyBy(taken.build());
    yield* Effect.forEach(
      stuck,
      (ticket) =>
        repo
          .save(ticket.release())
          .pipe(Effect.catch((error) => Console.error(`Failed to release ticket ${ticket.id} after the run`, error))),
      { discard: true }
    );
  });

export const runHarness = Effect.fn('harness.run')(function* ({
  project,
  queue,
  concurrency = 1,
  idleTimeout = defaultIdleTimeout,
  pollInterval = defaultPollInterval,
}: RunHarnessCommand) {
  const root = yield* RepositoryRoot;
  yield* ensureWorktreesWritable(root);
  const harness = yield* createHarness;
  const availableRunners = yield* Queue.unbounded<Runner>();
  yield* Queue.offerAll(
    availableRunners,
    Array.from({ length: concurrency }, () => harness.spawn())
  );
  const clock = yield* makeIdleClock(idleTimeout);
  const tickets = ticketStream(project, clock, pollInterval);
  const limitedTickets = queue === undefined ? tickets : tickets.pipe(Stream.take(queue));
  yield* Effect.annotateCurrentSpan({
    'harness.id': harness.id,
    'harness.concurrency': concurrency,
    'harness.queue': queue ?? -1,
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
    Effect.catchTag('HarnessIdleTimeout', (error) => Console.log(error.message)),
    Effect.ensuring(releaseTakenTickets(project))
  );
});
