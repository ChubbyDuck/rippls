import { Context, type Effect } from 'effect';

import type { Project } from '~/Core/Tickets/Domain/Entities/Ticket/properties/Project';
import type { TicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';
import type { WorktreeCloseError } from '~/Core/Tickets/Domain/Exceptions/WorktreeCloseError';
import type { WorktreeCreationError } from '~/Core/Tickets/Domain/Exceptions/WorktreeCreationError';

export interface Worktree {
  readonly path: string;
  readonly branch: string;
}

export class WorktreeManager extends Context.Service<
  WorktreeManager,
  {
    readonly prepareProject: (project: Project) => Effect.Effect<Worktree, WorktreeCreationError>;
    readonly prepareTicket: (input: {
      readonly id: TicketId;
      readonly project?: Project;
    }) => Effect.Effect<Worktree, WorktreeCreationError>;
    readonly mergeAndClose: (worktree: Worktree) => Effect.Effect<void, WorktreeCloseError>;
  }
>()('WorktreeManager') {}
