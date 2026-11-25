import { Console, Effect } from 'effect';

import type { CommitConfig } from '~/Core/Shared/Domain/EngineConfig';
import type { Harness } from '~/Core/Shared/Ports/Harness';
import type { Ticket } from '~/Core/Tickets/Domain/Entities/Ticket/entity';
import { renderPrompt } from '~/Core/Tickets/Domain/Services/promptTemplate';
import { type Worktree, WorktreeManager } from '~/Core/Tickets/Ports/WorktreeManager';

// Makes sure the work in the Ticket Worktree is committed, whichever skill did it.
// A clean worktree needs nothing. A dirty one gets the commit prompt through the
// Harness, with its model demand, and is asked again. The value tells whether the
// worktree is clean in the end.
export const commitTicketWorktree = Effect.fn('ticket.commit')(function* (
  ticket: Ticket,
  worktree: Worktree,
  harness: Harness,
  commit: CommitConfig
) {
  const worktrees = yield* WorktreeManager;
  const readWhetherClean = worktrees.changedPaths(worktree).pipe(Effect.map((paths) => paths.length === 0));
  const committed = Console.log(`${ticket.label} has its work committed on branch ${worktree.branch}`);
  if (yield* readWhetherClean) {
    yield* committed;
    return true;
  }
  yield* Console.log(`${ticket.label} has uncommitted work on branch ${worktree.branch}, so the commit prompt is sent`);
  yield* harness.run(renderPrompt(commit.prompt, ticket), { label: `ticket-${ticket.id}-commit`, model: commit.model });
  const clean = yield* readWhetherClean;
  yield* clean
    ? committed
    : Console.error(`${ticket.label} still has uncommitted work on branch ${worktree.branch} after the commit prompt`);
  return clean;
});
