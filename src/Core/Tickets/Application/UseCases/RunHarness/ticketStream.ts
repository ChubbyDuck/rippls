import { type Duration, Effect, Option, Stream } from 'effect';

import { defaultPollInterval } from '~/Core/Shared/Domain/HarnessConfig';
import type { Project } from '~/Core/Tickets/Domain/Entities/Ticket/properties/Project';

import type { IdleClock } from './idleClock';
import { pollTicket } from './pollTicket';

const ignoreIdle: Pick<IdleClock, 'onEmpty' | 'onClaim'> = {
  onEmpty: Effect.void,
  onClaim: Effect.void,
};

export const ticketStream = (
  project?: Project,
  clock: Pick<IdleClock, 'onEmpty' | 'onClaim'> = ignoreIdle,
  pollInterval: Duration.Input = defaultPollInterval
) =>
  Stream.fromEffectRepeat(
    pollTicket(project).pipe(
      Effect.tap((ticket) => (Option.isNone(ticket) ? clock.onEmpty : clock.onClaim)),
      Effect.tap((ticket) => (Option.isNone(ticket) ? Effect.sleep(pollInterval) : Effect.void)),
      Effect.repeat({ until: (ticket) => Option.isSome(ticket) }),
      Effect.map((ticket) => ticket.value)
    )
  );
