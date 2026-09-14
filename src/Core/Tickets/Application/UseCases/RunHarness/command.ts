import type { Duration } from 'effect';

import type { Project } from '~/Core/Tickets/Domain/Entities/Ticket/properties/Project';

export type RunHarnessCommand = {
  readonly project?: Project;
  readonly queue?: number;
  readonly concurrency?: number;
  readonly idleTimeout?: Duration.Input;
  readonly pollInterval?: Duration.Input;
};
