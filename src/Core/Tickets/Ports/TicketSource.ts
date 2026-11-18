import { Context, type Effect } from 'effect';

import type { Ticket } from '~/Core/Tickets/Domain/Entities/Ticket/entity';
import type { TicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';
import type { TicketEvent } from '~/Core/Tickets/Domain/Events/TicketEvent';
import type { TicketEventNotReported } from '~/Core/Tickets/Domain/Exceptions/TicketEventNotReported';
import type { TicketNotFound } from '~/Core/Tickets/Domain/Exceptions/TicketNotFound';
import type { TicketNotSaved } from '~/Core/Tickets/Domain/Exceptions/TicketNotSaved';
import type { TicketQuery } from '~/Core/Tickets/Domain/Queries/TicketQuery';

export class TicketSource extends Context.Service<
  TicketSource,
  {
    readonly getOneBy: (query: TicketQuery) => Effect.Effect<Ticket, TicketNotFound>;
    readonly getManyBy: (query: TicketQuery) => Effect.Effect<readonly Ticket[]>;
    readonly save: (ticket: Ticket) => Effect.Effect<void, TicketNotSaved>;
    readonly saveMany: (tickets: readonly Ticket[]) => Effect.Effect<void, TicketNotSaved>;
    /** Tells the Source what happened to a ticket. Each Source expresses the event in its own way. */
    readonly report: (ticket: TicketId, event: TicketEvent) => Effect.Effect<void, TicketEventNotReported>;
  }
>()('TicketSource') {}
