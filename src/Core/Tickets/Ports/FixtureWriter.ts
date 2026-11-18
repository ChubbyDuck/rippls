import { Context, type Effect } from 'effect';

import type { Ticket } from '~/Core/Tickets/Domain/Entities/Ticket/entity';
import type { FixtureNotWritten } from '~/Core/Tickets/Domain/Exceptions/FixtureNotWritten';

/** Writes generated fixture tickets where a Ticket Source can read them. Only the generator uses it. */
export class FixtureWriter extends Context.Service<
  FixtureWriter,
  {
    readonly write: (tickets: readonly Ticket[]) => Effect.Effect<void, FixtureNotWritten>;
  }
>()('FixtureWriter') {}
