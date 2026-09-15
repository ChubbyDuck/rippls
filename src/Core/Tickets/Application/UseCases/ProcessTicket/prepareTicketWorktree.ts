import { Effect } from 'effect';

import type { Project } from '~/Core/Tickets/Domain/Entities/Ticket/properties/Project';
import type { TicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';
import { WorktreeManager } from '~/Core/Tickets/Ports/WorktreeManager';

export const prepareTicketWorktree = (input: {
  readonly ticket: { readonly id: TicketId; readonly project?: Project };
}) => {
  const { project } = input.ticket;
  return WorktreeManager.pipe(
    Effect.flatMap((manager) =>
      project === undefined
        ? manager.prepareTicket({ id: input.ticket.id })
        : manager.prepareProject(project).pipe(Effect.andThen(manager.prepareTicket({ id: input.ticket.id, project })))
    )
  );
};
