import { Deferred, Effect, Fiber, Stream } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, test } from 'vitest';

import { Ticket } from '~/Core/Tickets/Domain/Entities/Ticket/entity';
import { formatTicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';
import { TicketNotFound } from '~/Core/Tickets/Domain/Exceptions/TicketNotFound';
import { TicketSource } from '~/Core/Tickets/Ports/TicketSource';

import { ticketStream } from './ticketStream';

const sampleTicket = (value: number) =>
  Ticket.create({
    id: formatTicketId('folder', String(value)),
    title: 'Stream ticket',
    project: 'test-project',
    kind: 'implementation',
    status: 'ready-for-agent',
    blockedBy: [],
    blocks: [],
    body: '',
  });

test('ticketStream hides empty polls, retries each 10 seconds, and emits available tickets without delay', async () => {
  const first = sampleTicket(1);
  const second = sampleTicket(2);
  const third = sampleTicket(3);
  const responses = [first, undefined, undefined, second, third];
  const emitted: Ticket[] = [];
  let reads = 0;

  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* ticketStream().pipe(
        Stream.take(3),
        Stream.runForEach((ticket) =>
          Effect.sync(() => {
            emitted.push(ticket);
          })
        ),
        Effect.forkChild({ startImmediately: true })
      );

      expect(emitted).toEqual([first.markClaiming()]);
      expect(reads).toBe(2);
      yield* TestClock.adjust('9999 millis');
      expect(reads).toBe(2);
      yield* TestClock.adjust('1 millis');
      expect(reads).toBe(3);
      expect(emitted).toEqual([first.markClaiming()]);
      yield* TestClock.adjust('9999 millis');
      expect(reads).toBe(3);
      yield* TestClock.adjust('1 millis');
      yield* Fiber.join(fiber);

      expect(emitted).toEqual([first.markClaiming(), second.markClaiming(), third.markClaiming()]);
      expect(reads).toBe(5);
      yield* TestClock.adjust('10 seconds');
      expect(reads).toBe(5);
    }).pipe(
      Effect.provideService(TicketSource, {
        getOneBy: () =>
          Effect.suspend(() => {
            const ticket = responses[reads++];
            return ticket === undefined ? Effect.fail(new TicketNotFound()) : Effect.succeed(ticket);
          }),
        getManyBy: () => Effect.succeed([]),
        save: () => Effect.void,
        saveMany: () => Effect.void,
      }),
      Effect.provide(TestClock.layer())
    )
  );
});

test('ticketStream retries empty polls at the given pollInterval', async () => {
  let reads = 0;

  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* ticketStream(undefined, undefined, '2 seconds').pipe(
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
      Effect.provideService(TicketSource, {
        getOneBy: () =>
          Effect.suspend(() => {
            reads += 1;
            return reads === 2 ? Effect.succeed(sampleTicket(1)) : Effect.fail(new TicketNotFound());
          }),
        getManyBy: () => Effect.succeed([]),
        save: () => Effect.void,
        saveMany: () => Effect.void,
      }),
      Effect.provide(TestClock.layer())
    )
  );
});

test('ticketStream waits for downstream demand before reading another ticket', async () => {
  let reads = 0;

  await Effect.runPromise(
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>();
      const fiber = yield* ticketStream().pipe(
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
      Effect.provideService(TicketSource, {
        getOneBy: () => Effect.sync(() => sampleTicket(++reads)),
        getManyBy: () => Effect.succeed([]),
        save: () => Effect.void,
        saveMany: () => Effect.void,
      }),
      Effect.provide(TestClock.layer())
    )
  );
});
