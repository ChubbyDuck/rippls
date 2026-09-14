import { Context, type Effect } from 'effect';

import type { Project } from '~/Core/Tickets/Domain/Entities/Ticket/properties/Project';
import type { TicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';
import type { WorktreeCloseError } from '~/Core/Tickets/Domain/Exceptions/WorktreeCloseError';
import type { WorktreeCreationError } from '~/Core/Tickets/Domain/Exceptions/WorktreeCreationError';

export interface Worktree {
  readonly path: string;
  readonly branch: string;
}

export class WorktreeRepository extends Context.Service<
  WorktreeRepository,
  {
    readonly projectAnchor: (project: Project) => Effect.Effect<Worktree, WorktreeCreationError>;
    readonly ticketAnchor: (input: {
      readonly id: TicketId;
      readonly project?: Project;
    }) => Effect.Effect<Worktree, WorktreeCreationError>;
    readonly close: (worktree: Worktree) => Effect.Effect<void, WorktreeCloseError>;
  }
>()('WorktreeRepository') {}
