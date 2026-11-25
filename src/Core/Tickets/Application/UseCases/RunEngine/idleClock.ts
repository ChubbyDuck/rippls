import { Deferred, Duration, Effect, Fiber, Ref } from 'effect';

import { EngineIdleTimeout } from '~/Core/Tickets/Domain/Exceptions/EngineIdleTimeout';

/**
 * Whether Ticket Processing is in progress at one moment, and an effect that waits
 * for the first Ticket Processing to end after that moment.
 */
export type Processing = {
  readonly inProgress: boolean;
  readonly nextEnd: Effect.Effect<void>;
};

export type IdleClock = {
  readonly onEmpty: Effect.Effect<void>;
  readonly onClaim: Effect.Effect<void>;
  readonly onDone: Effect.Effect<void>;
  readonly processing: Effect.Effect<Processing>;
  readonly awaitTimeout: Effect.Effect<never, EngineIdleTimeout>;
};

/**
 * Tracks the Ticket Processing in progress. With an idle timeout, the Engine halts
 * once it has been Idle for that long; with none, it never halts for being Idle.
 */
export const makeIdleClock = (idleTimeout?: Duration.Input): Effect.Effect<IdleClock> =>
  Effect.gen(function* () {
    const idleFor = idleTimeout === undefined ? undefined : Duration.fromInputUnsafe(idleTimeout);
    const occupied = yield* Ref.make(0);
    const ended = yield* Ref.make(yield* Deferred.make<void>());
    const timeout = yield* Ref.make<Fiber.Fiber<boolean> | undefined>(undefined);
    const halted = yield* Deferred.make<never, EngineIdleTimeout>();

    const stopTimeout = Ref.get(timeout).pipe(
      Effect.flatMap((fiber) => (fiber === undefined ? Effect.void : Fiber.interrupt(fiber))),
      Effect.andThen(Ref.set(timeout, undefined))
    );

    const startTimeout = Effect.gen(function* () {
      const existing = yield* Ref.get(timeout);
      if (idleFor === undefined || existing !== undefined) {
        return;
      }
      const fiber = yield* Effect.sleep(idleFor).pipe(
        Effect.andThen(Deferred.fail(halted, new EngineIdleTimeout({ idleTimeout: idleFor }))),
        Effect.forkChild
      );
      yield* Ref.set(timeout, fiber);
    });

    // Each end of Ticket Processing completes the signal that waiters hold, and
    // sets a fresh one for later waiters.
    const signalEnd = Effect.gen(function* () {
      const next = yield* Deferred.make<void>();
      const current = yield* Ref.getAndSet(ended, next);
      yield* Deferred.succeed(current, undefined);
    });

    return {
      onEmpty: Ref.get(occupied).pipe(Effect.flatMap((count) => (count === 0 ? startTimeout : Effect.void))),
      onClaim: Ref.update(occupied, (count) => count + 1).pipe(Effect.andThen(stopTimeout)),
      onDone: Ref.update(occupied, (count) => Math.max(0, count - 1)).pipe(Effect.andThen(signalEnd)),
      // The signal is read before the count, so an end between the two reads has
      // already completed the signal this poll holds.
      processing: Effect.all({ signal: Ref.get(ended), count: Ref.get(occupied) }).pipe(
        Effect.map(({ count, signal }) => ({ inProgress: count > 0, nextEnd: Deferred.await(signal) }))
      ),
      awaitTimeout: Deferred.await(halted),
    };
  });
