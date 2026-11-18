import { Context, type Effect } from 'effect';

import type { Ticket } from '~/Core/Tickets/Domain/Entities/Ticket/entity';
import type { TicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';
import type { ReportedEvent } from '~/Core/Tickets/Domain/Events/TicketEvent';
import type { TicketEventNotReported } from '~/Core/Tickets/Domain/Exceptions/TicketEventNotReported';
import type { TicketNotFound } from '~/Core/Tickets/Domain/Exceptions/TicketNotFound';
import type { TicketQuery } from '~/Core/Tickets/Domain/Queries/TicketQuery';
import type { Worktree } from '~/Core/Tickets/Ports/WorktreeManager';

/**
 * What a Source does once the merge of the Ticket Worktree succeeds, to finish the
 * done it was told of before the merge. The Engine runs it only after a merge that
 * succeeds.
 */
export type AfterMerge = Effect.Effect<void, TicketEventNotReported>;

/**
 * Where tickets are read from. Rippls never saves a Ticket to it: it reports what
 * happened to a ticket, and each Source expresses the event in its own way.
 */
export class TicketSource extends Context.Service<
  TicketSource,
  {
    readonly getOneBy: (query: TicketQuery) => Effect.Effect<Ticket, TicketNotFound>;
    readonly getManyBy: (query: TicketQuery) => Effect.Effect<readonly Ticket[]>;
    /** Tells the Source what happened to a ticket. Done is told with `reportDone`. */
    readonly report: (
      ticket: TicketId,
      event: ReportedEvent
    ) => Effect.Effect<void, TicketEventNotReported>;
    /**
     * Tells the Source that the ticket is done, before the merge of its Ticket
     * Worktree, so that what the Source changes there lands with the work. It
     * returns what the Source does once that merge succeeds.
     */
    readonly reportDone: (ticket: TicketId, worktree: Worktree) => Effect.Effect<AfterMerge, TicketEventNotReported>;
  }
>()('TicketSource') {}
