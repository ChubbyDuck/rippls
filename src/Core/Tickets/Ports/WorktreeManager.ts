import { Context, type Duration, type Effect } from 'effect';

import type { Project } from '~/Core/Tickets/Domain/Entities/Ticket/properties/Project';
import type { TicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';
import type { WorktreeCloseError } from '~/Core/Tickets/Domain/Exceptions/WorktreeCloseError';
import type { WorktreeCommandError } from '~/Core/Tickets/Domain/Exceptions/WorktreeCommandError';
import type { WorktreeCreationError } from '~/Core/Tickets/Domain/Exceptions/WorktreeCreationError';
import type { WorktreeNotExpected } from '~/Core/Tickets/Domain/Exceptions/WorktreeNotExpected';

// Where the work of a ticket happens. A Ticket Worktree is retained for a human
// after an escalation; the Repository Root in place says `retained: false`, since
// there is no worktree to keep.
export interface Worktree {
  readonly path: string;
  readonly branch: string;
  readonly retained?: false;
}

// How a command run in a worktree ended: it exited with a code, or the time limit
// ended it. The output holds stdout and stderr, interleaved as written.
export type CommandRun =
  | { readonly _tag: 'Exited'; readonly exitCode: number; readonly output: string }
  | { readonly _tag: 'TimedOut'; readonly output: string };

export class WorktreeManager extends Context.Service<
  WorktreeManager,
  {
    // In Ticket Worktrees, both preparations reuse a directory already on disk only
    // when it is the Git worktree on the expected branch. Otherwise they fail with
    // WorktreeNotExpected. In place, both return the Repository Root on its current
    // branch, and merge and close does nothing.
    readonly prepareProject: (project: Project) => Effect.Effect<Worktree, WorktreeCreationError | WorktreeNotExpected>;
    readonly prepareTicket: (input: {
      readonly id: TicketId;
      readonly project?: Project;
    }) => Effect.Effect<Worktree, WorktreeCreationError | WorktreeNotExpected>;
    readonly mergeAndClose: (worktree: Worktree) => Effect.Effect<void, WorktreeCloseError>;
    // Runs a command through a shell in the worktree directory. The time limit
    // ends the command and every process it started.
    readonly runCommand: (input: {
      readonly worktree: Worktree;
      readonly command: string;
      readonly timeLimit: Duration.Input;
    }) => Effect.Effect<CommandRun, WorktreeCommandError>;
    // Whether the worktree is clean: no uncommitted change, and no untracked file
    // that Git does not ignore. In place, the untracked files under the tickets
    // folder do not count.
    readonly isClean: (worktree: Worktree) => Effect.Effect<boolean, WorktreeCommandError>;
  }
>()('WorktreeManager') {}
