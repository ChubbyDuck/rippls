import { Effect } from 'effect';

import type { Project } from '~/Core/Tickets/Domain/Entities/Ticket/properties/Project';
import type { TicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';
import { WorktreeRepository } from '~/Core/Tickets/Ports/WorktreeRepository';

export const resolveAnchor = (input: {
  readonly ticket: { readonly id: TicketId; readonly project?: Project };
}) => {
  const { project } = input.ticket;
  return WorktreeRepository.pipe(
    Effect.flatMap((repo) =>
      project === undefined
        ? repo.ticketAnchor({ id: input.ticket.id })
        : repo.projectAnchor(project).pipe(Effect.andThen(repo.ticketAnchor({ id: input.ticket.id, project })))
    )
  );
};
