import { Deferred, Effect, Fiber, Layer, Schema, Stream } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, test } from 'vitest';

import { EngineId } from '~/Core/Shared/Domain/Properties/EngineId';
import { Ticket } from '~/Core/Tickets/Domain/Entities/Ticket/entity';
import { formatTicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';
import { TicketNotFound } from '~/Core/Tickets/Domain/Exceptions/TicketNotFound';
import type { TicketQuery } from '~/Core/Tickets/Domain/Queries/TicketQuery';
import { TicketSource } from '~/Core/Tickets/Ports/TicketSource';
import { makeLedgerMemory } from '~/Infrastructure/Tickets/Ledger/memory';

import { ticketStream } from './ticketStream';

const engine = Schema.decodeSync(EngineId)('stream-engine');

const sampleTicket = (value: number) =>
  Ticket.create({
    id: formatTicketId('folder', String(value)),
    title: 'Stream ticket',
    project: 'test-project',
    kind: 'implementation',
    blockedBy: [],
    body: '',
  });

// Each poll reads the tickets in scope once: `next` gives what the Source holds
// at that read. The chosen ticket is then read by identity.
const scriptedSource = (next: () => Ticket | undefined) => {
  const seen = new Map<string, Ticket>();
  return TicketSource.of({
    getOneBy: (query: TicketQuery) =>
      Effect.suspend(() => {
        const found = query.id === undefined ? undefined : seen.get(query.id);
        return found === undefined ? Effect.fail(new TicketNotFound()) : Effect.succeed(found);
      }),
    getManyBy: () =>
      Effect.sync(() => {
        const ticket = next();
        if (ticket === undefined) {
          return [];
        }
        seen.set(ticket.id, ticket);
        return [ticket];
      }),
    report: () => Effect.void,
    reportDone: () => Effect.succeed(Effect.void),
  });
};

test('ticketStream hides empty polls, retries each 10 seconds, and emits available tickets without delay', async () => {
  const first = sampleTicket(1);
  const second = sampleTicket(2);
  const third = sampleTicket(3);
  const responses = [first, undefined, undefined, second, third];
  const emitted: Ticket[] = [];
  let reads = 0;

  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* ticketStream(engine).pipe(
        Stream.take(3),
        Stream.runForEach((ticket) =>
          Effect.sync(() => {
            emitted.push(ticket);
          })
        ),
        Effect.forkChild({ startImmediately: true })
      );

      expect(emitted).toEqual([first]);
      expect(reads).toBe(2);
      yield* TestClock.adjust('9999 millis');
      expect(reads).toBe(2);
      yield* TestClock.adjust('1 millis');
      expect(reads).toBe(3);
      expect(emitted).toEqual([first]);
      yield* TestClock.adjust('9999 millis');
      expect(reads).toBe(3);
      yield* TestClock.adjust('1 millis');
      yield* Fiber.join(fiber);

      expect(emitted).toEqual([first, second, third]);
      expect(reads).toBe(5);
      yield* TestClock.adjust('10 seconds');
      expect(reads).toBe(5);
    }).pipe(
      Effect.provideService(
        TicketSource,
        scriptedSource(() => responses[reads++])
      ),
      Effect.provide(Layer.merge(makeLedgerMemory().layer, TestClock.layer()))
    )
  );
});

test('ticketStream retries empty polls at the given pollInterval', async () => {
  let reads = 0;

  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* ticketStream(engine, undefined, undefined, '2 seconds').pipe(
        Stream.take(1),
        Stream.runDrain,
        Effect.forkChild({ startImmediately: true })
      );

      expect(reads).toBe(1);
      yield* TestClock.adjust('1999 millis');
      expect(reads).toBe(1);
      yield* TestClock.adjust('1 millis');
      yield* Fiber.join(fiber);
      expect(reads).toBe(2);
    }).pipe(
      Effect.provideService(
        TicketSource,
        scriptedSource(() => {
          reads += 1;
          return reads === 2 ? sampleTicket(1) : undefined;
        })
      ),
      Effect.provide(Layer.merge(makeLedgerMemory().layer, TestClock.layer()))
    )
  );
});

test('ticketStream waits for downstream demand before reading another ticket', async () => {
  let reads = 0;

  await Effect.runPromise(
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>();
      const fiber = yield* ticketStream(engine).pipe(
        Stream.take(2),
        Stream.runForEach(() => Deferred.await(release)),
        Effect.forkChild({ startImmediately: true })
      );

      expect(reads).toBe(1);
      yield* TestClock.adjust('6 minutes');
      expect(reads).toBe(1);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(fiber);
      expect(reads).toBe(2);
    }).pipe(
      Effect.provideService(
        TicketSource,
        scriptedSource(() => sampleTicket(++reads))
      ),
      Effect.provide(Layer.merge(makeLedgerMemory().layer, TestClock.layer()))
    )
  );
});
