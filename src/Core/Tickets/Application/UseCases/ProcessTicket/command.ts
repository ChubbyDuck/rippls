import type { CheckConfig, CommitConfig } from '~/Core/Shared/Domain/EngineConfig';
import type { RunnerId } from '~/Core/Shared/Domain/Properties/RunnerId';
import type { Ticket } from '~/Core/Tickets/Domain/Entities/Ticket/entity';

export type ProcessTicketCommand = {
  readonly ticket: Ticket;
  readonly runnerId: RunnerId;
  readonly repositoryRoot: string;
  // The check that runs after the Strategy succeeds. Without it the check is skipped.
  readonly check?: CheckConfig;
  // The commit prompt for a Ticket Worktree left dirty. Without it the default is used.
  readonly commit?: CommitConfig;
};
