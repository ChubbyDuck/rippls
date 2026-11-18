import { type Duration, Effect, Option, Stream } from 'effect';

import { defaultPollInterval } from '~/Core/Shared/Domain/EngineConfig';
import type { EngineId } from '~/Core/Shared/Domain/Properties/EngineId';
import type { Project } from '~/Core/Tickets/Domain/Entities/Ticket/properties/Project';

import type { IdleClock } from './idleClock';
import { pollTicket } from './pollTicket';

const ignoreIdle: Pick<IdleClock, 'onEmpty' | 'onClaim'> = {
  onEmpty: Effect.void,
  onClaim: Effect.void,
};

/** The tickets the Engine claims, one at a time, as downstream demands them. */
export const ticketStream = (
  engine: EngineId,
  project?: Project,
  clock: Pick<IdleClock, 'onEmpty' | 'onClaim'> = ignoreIdle,
  pollInterval: Duration.Input = defaultPollInterval
) =>
  Stream.fromEffectRepeat(
    pollTicket(engine, project).pipe(
      Effect.tap((ticket) => (Option.isNone(ticket) ? clock.onEmpty : clock.onClaim)),
      Effect.tap((ticket) => (Option.isNone(ticket) ? Effect.sleep(pollInterval) : Effect.void)),
      Effect.repeat({ until: (ticket) => Option.isSome(ticket) }),
      Effect.map((ticket) => ticket.value)
    )
  );
