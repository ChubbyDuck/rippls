import type { Duration } from 'effect';

import type { CheckConfig, CommitConfig, Workspace } from '~/Core/Shared/Domain/EngineConfig';
import type { Project } from '~/Core/Tickets/Domain/Entities/Ticket/properties/Project';

export type RunEngineCommand = {
  readonly project?: Project;
  readonly limit?: number;
  readonly concurrency?: number;
  // Where the work of each ticket happens. In place allows a Concurrency of one.
  readonly workspace?: Workspace;
  // A Watch keeps polling while the Engine is Idle. A Drain, the default, ends the
  // run as soon as the Engine is Idle.
  readonly watch?: boolean;
  // How long a Watch stays Idle before it ends. With none, it never ends for being
  // Idle. A Drain ignores it.
  readonly idleTimeout?: Duration.Input;
  readonly pollInterval?: Duration.Input;
  // The check that runs in the Workspace of each ticket after its Strategy succeeds.
  readonly check?: CheckConfig;
  // The commit prompt and its model demand, for a Workspace left dirty after the check.
  readonly commit?: CommitConfig;
};
