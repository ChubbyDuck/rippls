import type { Duration } from 'effect';

import type { CheckConfig, CommitConfig, Workspace } from '~/Core/Shared/Domain/EngineConfig';
import type { Project } from '~/Core/Tickets/Domain/Entities/Ticket/properties/Project';

export type RunEngineCommand = {
  readonly project?: Project;
  readonly limit?: number;
  readonly concurrency?: number;
  // Where the work of each ticket happens. In place allows a Concurrency of one.
  readonly workspace?: Workspace;
  readonly idleTimeout?: Duration.Input;
  readonly pollInterval?: Duration.Input;
  // The check that runs in each Ticket Worktree after its Strategy succeeds.
  readonly check?: CheckConfig;
  // The commit prompt and its model demand, for a Ticket Worktree left dirty after the check.
  readonly commit?: CommitConfig;
};
