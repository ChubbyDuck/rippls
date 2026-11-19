import type { Ticket } from '../Entities/Ticket/entity';
import type { Project } from '../Entities/Ticket/properties/Project';
import type { TicketId } from '../Entities/Ticket/properties/TicketId';

/** What a read of a Source asks for: a ticket by its identity, the tickets of a Project, both, or every ticket. */
export type TicketQuery = {
  readonly id?: TicketId;
  readonly project?: Project;
};

/** A Ticket matches a query when it has every one of the `id` and `project` the query states. */
export const matchesQuery =
  (query: TicketQuery) =>
  (ticket: Ticket): boolean =>
    (query.id === undefined || ticket.id === query.id) &&
    (query.project === undefined || ticket.project === query.project);
