import { Console, type Duration, Effect, Option, Stream } from 'effect';

import { defaultPollInterval } from '~/Core/Shared/Domain/EngineConfig';
import type { EngineId } from '~/Core/Shared/Domain/Properties/EngineId';
import type { Ticket } from '~/Core/Tickets/Domain/Entities/Ticket/entity';
import type { Project } from '~/Core/Tickets/Domain/Entities/Ticket/properties/Project';
import type { RepositoryRootDirty } from '~/Core/Tickets/Domain/Exceptions/RepositoryRootDirty';
import type { WorktreeCommandError } from '~/Core/Tickets/Domain/Exceptions/WorktreeCommandError';

import type { IdleClock, Processing } from './idleClock';
import { pollTicket } from './pollTicket';

export type TicketStreamClock = Pick<IdleClock, 'onEmpty' | 'onClaim' | 'onWaiting' | 'processing'>;

const ignoreIdle: TicketStreamClock = {
  onEmpty: Effect.void,
  onClaim: Effect.void,
  onWaiting: Effect.void,
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

// A poll that a Watch skipped, since the Repository Root was not clean.
const skipped = Symbol('skipped');

export type TicketStreamOptions = {
  readonly project?: Project;
  readonly clock?: TicketStreamClock;
  readonly pollInterval?: Duration.Input;
  // A Watch keeps polling while the Engine is Idle. A Drain, the default, ends the
  // stream once it is Idle, after `onIdle`.
  readonly watch?: boolean;
  readonly onIdle?: Effect.Effect<void>;
  // In place, the check that the Repository Root is clean, which runs once a poll
  // finds an Eligible ticket and before it claims one. A Drain fails with its error.
  // A Watch logs it and takes no ticket until a later poll finds the tree clean.
  readonly cleanRootCheck?: Effect.Effect<void, RepositoryRootDirty | WorktreeCommandError>;
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
    cleanRootCheck = Effect.void,
  }: TicketStreamOptions = {}
) => {
  const unreadable = 'Could not read whether the Repository Root is clean';
  // A Watch that finds the Repository Root dirty, or cannot read it, skips the poll.
  // An Eligible ticket waits, so the Engine is not Idle.
  const skip = (reason: string) =>
    Console.log(`${reason}\nThe Watch takes no ticket until the next poll`).pipe(Effect.as(skipped));
  const pollOnce = watch
    ? pollTicket(engine, project, cleanRootCheck).pipe(
        Effect.catchTags({
          RepositoryRootDirty: (error) => skip(error.message),
          WorktreeCommandError: () => skip(unreadable),
        })
      )
    : pollTicket(engine, project, cleanRootCheck).pipe(
        Effect.tapErrorTag('WorktreeCommandError', () => Console.error(unreadable))
      );
  const waitForNextPoll = (before: Processing) =>
    Effect.sleep(pollInterval).pipe(Effect.raceFirst(before.nextEnd), Effect.as(again));
  const poll = Effect.gen(function* () {
    const before = yield* clock.processing;
    const ticket = yield* pollOnce;
    if (ticket === skipped) {
      yield* clock.onWaiting;
      return yield* waitForNextPoll(before);
    }
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
    return yield* waitForNextPoll(before);
  });
  return Stream.unfold(undefined, () =>
    poll.pipe(
      Effect.repeat({ until: (outcome) => outcome._tag !== 'Again' }),
      Effect.map((outcome) => (outcome._tag === 'Claimed' ? ([outcome.ticket, undefined] as const) : undefined))
    )
  );
};
