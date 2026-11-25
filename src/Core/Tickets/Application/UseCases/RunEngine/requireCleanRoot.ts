import { Effect } from 'effect';

import { RepositoryRootDirty } from '~/Core/Tickets/Domain/Exceptions/RepositoryRootDirty';
import type { WorktreeManager } from '~/Core/Tickets/Ports/WorktreeManager';

// In place, an Agent commits in the Repository Root, so a change the developer has
// not committed would go into its commit. The check fails with the changed paths;
// the untracked files under the tickets folder do not count (see ADR-0005).
export const requireCleanRoot = (worktrees: WorktreeManager['Service'], root: string) =>
  worktrees.changedPaths({ path: root }).pipe(
    Effect.filterOrFail(
      (paths) => paths.length === 0,
      (paths) => new RepositoryRootDirty({ root, paths })
    ),
    Effect.asVoid
  );
