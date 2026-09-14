import type { RunnerId } from '~/Core/Shared/Domain/Properties/RunnerId';
import type { Ticket } from '~/Core/Tickets/Domain/Entities/Ticket/entity';

export type ProcessTicketCommand = {
  readonly ticket: Ticket;
  readonly runnerId: RunnerId;
  readonly repositoryRoot: string;
};
