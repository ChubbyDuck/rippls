import { Console, type Duration, Effect, Option, Stream } from 'effect';

import { defaultPollInterval } from '~/Core/Shared/Domain/EngineConfig';
import type { EngineId } from '~/Core/Shared/Domain/Properties/EngineId';
import type { Project } from '~/Core/Tickets/Domain/Entities/Ticket/properties/Project';

import type { IdleClock } from './idleClock';
import { pollTicket } from './pollTicket';

export type TicketStreamClock = Pick<IdleClock, 'onEmpty' | 'onClaim' | 'processing'>;

const ignoreIdle: TicketStreamClock = {
  onEmpty: Effect.void,
  onClaim: Effect.void,
  processing: Effect.succeed({ inProgress: false, nextEnd: Effect.never }),
};

export type TicketStreamOptions = {
  readonly project?: Project;
  readonly clock?: TicketStreamClock;
  readonly pollInterval?: Duration.Input;
  // A Watch keeps polling while the Engine is Idle. A Drain, the default, ends the
  // stream once it is Idle, after `onIdle`.
  readonly watch?: boolean;
  readonly onIdle?: Effect.Effect<void>;
};

/**
 * The tickets the Engine claims, one at a time, as downstream demands them. An
 * empty poll that started with no Ticket Processing in progress finds the Engine
 * Idle, which ends a Drain. Otherwise the next poll comes after the poll interval,
 * or as soon as a Ticket Processing in progress ends, since its end may make a
 * ticket Eligible.
 */
export const ticketStream = (
  engine: EngineId,
  {
    project,
    clock = ignoreIdle,
    pollInterval = defaultPollInterval,
    watch = false,
    onIdle = Effect.void,
  }: TicketStreamOptions = {}
) => {
  // A poll gives the ticket it claimed, or ends the stream when the Engine is
  // Idle in a Drain, or asks for another poll.
  const poll = Effect.gen(function* () {
    const before = yield* clock.processing;
    const ticket = yield* pollTicket(engine, project);
    if (Option.isSome(ticket)) {
      yield* clock.onClaim;
      return ticket.value;
    }
    yield* clock.onEmpty;
    if (!watch && !before.inProgress) {
      yield* onIdle;
      return 'idle';
    }
    yield* Console.log('No tickets are found, continuing');
    yield* Effect.sleep(pollInterval).pipe(Effect.raceFirst(before.nextEnd));
    return 'again';
  });
  return Stream.unfold(undefined, () =>
    poll.pipe(
      Effect.repeat({ until: (result) => result !== 'again' }),
      Effect.map((result) => (typeof result === 'string' ? undefined : ([result, undefined] as const)))
    )
  );
};
