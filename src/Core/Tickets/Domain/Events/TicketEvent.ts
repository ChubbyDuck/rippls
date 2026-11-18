import { Schema } from 'effect';

/** What Rippls reports to a Ticket Source about a ticket. Each Source expresses it in its own way. */
export const TicketEvent = Schema.Literals(['claimed', 'released', 'escalated', 'retried', 'done']);

export type TicketEvent = typeof TicketEvent.Type;

/** An event told with `report`. Done is told with `reportDone`, since it carries the Ticket Worktree. */
export type ReportedEvent = Exclude<TicketEvent, 'done'>;
