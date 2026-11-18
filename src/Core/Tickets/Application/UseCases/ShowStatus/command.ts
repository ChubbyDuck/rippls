import type { Project } from '~/Core/Tickets/Domain/Entities/Ticket/properties/Project';

export type ShowStatusCommand = {
  readonly project?: Project;
};
