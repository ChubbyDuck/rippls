import { Schema } from 'effect';

/** What the Engine reports to a Ticket Source about a ticket. Each Source expresses it in its own way. */
export const TicketEvent = Schema.Literals(['claimed', 'released', 'escalated']);

export type TicketEvent = typeof TicketEvent.Type;
