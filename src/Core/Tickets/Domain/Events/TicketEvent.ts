import { Schema } from 'effect';

/** What Rippls reports to a Ticket Source about a ticket. Each Source expresses it in its own way. */
export const TicketEvent = Schema.Literals(['claimed', 'released', 'escalated', 'retried', 'done']);

export type TicketEvent = typeof TicketEvent.Type;
