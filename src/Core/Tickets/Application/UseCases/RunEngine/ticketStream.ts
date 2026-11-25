import { Console, type Duration, Effect, Option, Stream } from 'effect';

import { defaultPollInterval } from '~/Core/Shared/Domain/EngineConfig';
import type { EngineId } from '~/Core/Shared/Domain/Properties/EngineId';
import type { Ticket } from '~/Core/Tickets/Domain/Entities/Ticket/entity';
import type { Project } from '~/Core/Tickets/Domain/Entities/Ticket/properties/Project';
import type { RepositoryRootDirty } from '~/Core/Tickets/Domain/Exceptions/RepositoryRootDirty';
import type { WorktreeCommandError } from '~/Core/Tickets/Domain/Exceptions/WorktreeCommandError';

import type { IdleClock } from './idleClock';
import { pollTicket } from './pollTicket';

export type TicketStreamClock = Pick<IdleClock, 'onEmpty' | 'onClaim' | 'processing'>;

const ignoreIdle: TicketStreamClock = {
  onEmpty: Effect.void,
  onClaim: Effect.void,
  processing: Effect.succeed({ inProgress: false, nextEnd: Effect.never }),
};

// What one poll leads to: a ticket the Engine claimed, the end of a Drain once the
// Engine is Idle, or another poll.
type PollOutcome =
  | { readonly _tag: 'Claimed'; readonly ticket: Ticket }
  | { readonly _tag: 'Idle' }
  | { readonly _tag: 'Again' };

const claimed = (ticket: Ticket): PollOutcome => ({ _tag: 'Claimed', ticket });
const idle: PollOutcome = { _tag: 'Idle' };
const again: PollOutcome = { _tag: 'Again' };

export type TicketStreamOptions = {
  readonly project?: Project;
  readonly clock?: TicketStreamClock;
  readonly pollInterval?: Duration.Input;
  // A Watch keeps polling while the Engine is Idle. A Drain, the default, ends the
  // stream once it is Idle, after `onIdle`.
  readonly watch?: boolean;
  readonly onIdle?: Effect.Effect<void>;
  // What must hold before each poll, as a clean Repository Root in place. A Drain
  // fails with its error. A Watch logs it and skips the poll, so it takes no ticket
  // until a later poll finds it holds.
  readonly beforePoll?: Effect.Effect<void, RepositoryRootDirty | WorktreeCommandError>;
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
    beforePoll = Effect.void,
  }: TicketStreamOptions = {}
) => {
  // A Watch that skips a poll counts it as an empty one.
  const skipped = (reason: string) =>
    clock.onEmpty.pipe(Effect.andThen(Console.log(`${reason}\nThe Watch takes no ticket until the next poll`)));
  const ready = watch
    ? beforePoll.pipe(
        Effect.as(true),
        Effect.catchTags({
          RepositoryRootDirty: (error) => skipped(error.message).pipe(Effect.as(false)),
          WorktreeCommandError: () =>
            skipped('Could not read whether the Repository Root is clean').pipe(Effect.as(false)),
        })
      )
    : beforePoll.pipe(Effect.as(true));
  const poll = Effect.gen(function* () {
    const before = yield* clock.processing;
    if (!(yield* ready)) {
      yield* Effect.sleep(pollInterval).pipe(Effect.raceFirst(before.nextEnd));
      return again;
    }
    const ticket = yield* pollTicket(engine, project);
    if (Option.isSome(ticket)) {
      yield* clock.onClaim;
      return claimed(ticket.value);
    }
    yield* clock.onEmpty;
    if (!watch && !before.inProgress) {
      yield* onIdle;
      return idle;
    }
    yield* Console.log('No tickets are found, continuing');
    yield* Effect.sleep(pollInterval).pipe(Effect.raceFirst(before.nextEnd));
    return again;
  });
  return Stream.unfold(undefined, () =>
    poll.pipe(
      Effect.repeat({ until: (outcome) => outcome._tag !== 'Again' }),
      Effect.map((outcome) => (outcome._tag === 'Claimed' ? ([outcome.ticket, undefined] as const) : undefined))
    )
  );
};
