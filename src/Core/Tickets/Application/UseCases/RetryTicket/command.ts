import type { TicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';

export type RetryTicketCommand = {
  readonly ticket: TicketId;
};
