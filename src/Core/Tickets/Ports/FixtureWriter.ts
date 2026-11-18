import { Context, type Effect, Schema } from 'effect';

import type { Hitl } from '~/Core/Tickets/Domain/Entities/Ticket/properties/Hitl';
import type { TicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';
import type { TicketKind } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketKind';
import type { FixtureNotWritten } from '~/Core/Tickets/Domain/Exceptions/FixtureNotWritten';

/**
 * The `status` a generated fixture stores. A Ticket stores no status: a Source
 * reads `ready-for-agent` only as a marker, and `done` places the fixture in `done/`.
 */
export const FixtureStatus = Schema.Literals(['open', 'ready-for-agent', 'done', 'resolved', 'blocked']);

export type FixtureStatus = typeof FixtureStatus.Type;

/** A generated ticket, with the fields a fixture file holds. */
export type Fixture = {
  readonly id: TicketId;
  readonly title: string;
  readonly project: string;
  readonly status: FixtureStatus;
  readonly kind: TicketKind;
  readonly hitl: Hitl;
  readonly blockedBy: readonly TicketId[];
  readonly blocks: readonly TicketId[];
  readonly body: string;
};

/** Writes generated fixture tickets where a Ticket Source can read them. Only the generator uses it. */
export class FixtureWriter extends Context.Service<
  FixtureWriter,
  {
    readonly write: (fixtures: readonly Fixture[]) => Effect.Effect<void, FixtureNotWritten>;
  }
>()('FixtureWriter') {}
