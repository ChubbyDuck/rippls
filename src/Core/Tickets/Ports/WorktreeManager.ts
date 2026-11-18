import { Context, type Duration, type Effect } from 'effect';

import type { Project } from '~/Core/Tickets/Domain/Entities/Ticket/properties/Project';
import type { TicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';
import type { WorktreeCloseError } from '~/Core/Tickets/Domain/Exceptions/WorktreeCloseError';
import type { WorktreeCommandError } from '~/Core/Tickets/Domain/Exceptions/WorktreeCommandError';
import type { WorktreeCreationError } from '~/Core/Tickets/Domain/Exceptions/WorktreeCreationError';

export interface Worktree {
  readonly path: string;
  readonly branch: string;
}

// How a command run in a worktree ended: it exited with a code, or the time limit
// ended it. The output holds stdout and stderr, interleaved as written.
export type CommandRun =
  | { readonly _tag: 'Exited'; readonly exitCode: number; readonly output: string }
  | { readonly _tag: 'TimedOut'; readonly output: string };

export class WorktreeManager extends Context.Service<
  WorktreeManager,
  {
    readonly prepareProject: (project: Project) => Effect.Effect<Worktree, WorktreeCreationError>;
    readonly prepareTicket: (input: {
      readonly id: TicketId;
      readonly project?: Project;
    }) => Effect.Effect<Worktree, WorktreeCreationError>;
    readonly mergeAndClose: (worktree: Worktree) => Effect.Effect<void, WorktreeCloseError>;
    // Runs a command through a shell in the worktree directory. The time limit
    // ends the command and every process it started.
    readonly runCommand: (input: {
      readonly worktree: Worktree;
      readonly command: string;
      readonly timeLimit: Duration.Input;
    }) => Effect.Effect<CommandRun, WorktreeCommandError>;
  }
>()('WorktreeManager') {}
