import { Deferred, type Duration, Effect, Fiber, Ref } from 'effect';

import { defaultIdleTimeout } from '~/Core/Shared/Domain/HarnessConfig';
import { HarnessIdleTimeout } from '~/Core/Tickets/Domain/Exceptions/HarnessIdleTimeout';

export type IdleClock = {
  readonly onEmpty: Effect.Effect<void>;
  readonly onClaim: Effect.Effect<void>;
  readonly onDone: Effect.Effect<void>;
  readonly awaitTimeout: Effect.Effect<never, HarnessIdleTimeout>;
};

export const makeIdleClock = (idleTimeout: Duration.Input = defaultIdleTimeout): Effect.Effect<IdleClock> =>
  Effect.gen(function* () {
    const occupied = yield* Ref.make(0);
    const timeout = yield* Ref.make<Fiber.Fiber<boolean> | undefined>(undefined);
    const halted = yield* Deferred.make<never, HarnessIdleTimeout>();

    const stopTimeout = Ref.get(timeout).pipe(
      Effect.flatMap((fiber) => (fiber === undefined ? Effect.void : Fiber.interrupt(fiber))),
      Effect.andThen(Ref.set(timeout, undefined))
    );

    const startTimeout = Effect.gen(function* () {
      const existing = yield* Ref.get(timeout);
      if (existing !== undefined) {
        return;
      }
      const fiber = yield* Effect.sleep(idleTimeout).pipe(
        Effect.andThen(Deferred.fail(halted, new HarnessIdleTimeout())),
        Effect.forkChild
      );
      yield* Ref.set(timeout, fiber);
    });

    return {
      onEmpty: Ref.get(occupied).pipe(Effect.flatMap((count) => (count === 0 ? startTimeout : Effect.void))),
      onClaim: Ref.update(occupied, (count) => count + 1).pipe(Effect.andThen(stopTimeout)),
      onDone: Ref.update(occupied, (count) => Math.max(0, count - 1)),
      awaitTimeout: Deferred.await(halted),
    };
  });
