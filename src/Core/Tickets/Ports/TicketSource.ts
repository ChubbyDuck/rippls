import { Context, type Effect } from 'effect';

import type { Ticket } from '~/Core/Tickets/Domain/Entities/Ticket/entity';
import type { TicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';
import type { UnreadableTicket } from '~/Core/Tickets/Domain/Entities/UnreadableTicket/entity';
import type { TicketEvent } from '~/Core/Tickets/Domain/Events/TicketEvent';
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
    /**
     * Every ticket the Source cannot read, with the reason, whatever its Project:
     * an unreadable ticket's Project cannot be read with certainty.
     */
    readonly getUnreadable: Effect.Effect<readonly UnreadableTicket[]>;
    /**
     * Tells the Source what happened to a ticket. A report can run again safely, and
     * changes the ticket only while Rippls holds it. Done here means that the work of
     * the ticket has landed: the Source completes the ticket if it has not yet, as Linear
     * does; the folder Source has nothing to finish, since its move lands with the
     * merge. The Engine reports it again on exit until it succeeds. Before the merge, done is told with
     * `reportDone`.
     */
    readonly report: (
      ticket: TicketId,
      event: TicketEvent
    ) => Effect.Effect<void, TicketEventNotReported>;
    /**
     * Tells the Source that the ticket is done, before the merge of its Ticket
     * Worktree, so that what the Source changes there lands with the work. It
     * returns what the Source does once that merge succeeds.
     */
    readonly reportDone: (ticket: TicketId, worktree: Worktree) => Effect.Effect<AfterMerge, TicketEventNotReported>;
  }
>()('rippls/Core/Tickets/Ports/TicketSource') {}
