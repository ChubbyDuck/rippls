import type { Duration } from 'effect';

import type { CheckConfig, CommitConfig } from '~/Core/Shared/Domain/EngineConfig';
import type { Project } from '~/Core/Tickets/Domain/Entities/Ticket/properties/Project';

export type RunEngineCommand = {
  readonly project?: Project;
  readonly limit?: number;
  readonly concurrency?: number;
  readonly idleTimeout?: Duration.Input;
  readonly pollInterval?: Duration.Input;
  // The check that runs in each Ticket Worktree after its Strategy succeeds.
  readonly check?: CheckConfig;
  // The commit prompt for a Ticket Worktree left dirty after the check.
  readonly commit?: CommitConfig;
};
