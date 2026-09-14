import { Context, type Effect } from 'effect';

import type { Ticket } from '~/Core/Tickets/Domain/Entities/Ticket/entity';
import type { TicketNotFound } from '~/Core/Tickets/Domain/Exceptions/TicketNotFound';
import type { TicketNotSaved } from '~/Core/Tickets/Domain/Exceptions/TicketNotSaved';
import type { TicketQuery } from '~/Core/Tickets/Domain/Queries/TicketQuery';

export class TicketRepository extends Context.Service<
  TicketRepository,
  {
    readonly getOneBy: (query: TicketQuery) => Effect.Effect<Ticket, TicketNotFound>;
    readonly getManyBy: (query: TicketQuery) => Effect.Effect<readonly Ticket[]>;
    readonly save: (ticket: Ticket) => Effect.Effect<void, TicketNotSaved>;
    readonly saveMany: (tickets: readonly Ticket[]) => Effect.Effect<void, TicketNotSaved>;
  }
>()('TicketRepository') {}
