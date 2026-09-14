import type { TicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';

export type CompleteTicketCommand = {
  readonly ticketId: TicketId;
};
