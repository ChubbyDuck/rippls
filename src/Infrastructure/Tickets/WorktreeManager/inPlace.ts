import { Effect, FileSystem, Layer, Path } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';

import { WorktreeCommandError } from '~/Core/Tickets/Domain/Exceptions/WorktreeCommandError';
import { WorktreeCreationError } from '~/Core/Tickets/Domain/Exceptions/WorktreeCreationError';
import { type Worktree, WorktreeManager } from '~/Core/Tickets/Ports/WorktreeManager';

import { changesOf, gitStatusIn } from './gitStatus';
import { runCommandWith } from './runCommand';

// The in-place Workspace: every Ticket's work happens in the Repository Root itself
// and lands on its current branch (see ADR-0005). Preparing a ticket or a Project
// returns the Repository Root, with no worktree and no dependency install, so a
// Project gives no Project Worktree. Merge and close does nothing: the work is
// already on the current branch. The clean check ignores the untracked files under
// the tickets folder, so a queue that Git does not track still counts as clean.
export const WorktreeManagerInPlaceLive = (repositoryRoot: string, ticketsDir?: string) =>
  Layer.effect(
    WorktreeManager,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const realPathOf = (target: string) => fs.realPath(target).pipe(Effect.orElseSucceed(() => target));

      // The tickets folder as Git names it: relative to the Repository Root, with
      // `/` between segments. Git lists a symbolic link to the folder as one
      // untracked file at its own path, so the folder counts by the path it was
      // given as well as by its real path. A folder outside the Repository Root, or
      // the Repository Root itself, gives no path: the clean check would otherwise
      // ignore every untracked file.
      const realRoot = yield* realPathOf(repositoryRoot);
      const inRoot = (relative: string) =>
        relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
          ? []
          : [relative.split(path.sep).join('/')];
      const queues =
        ticketsDir === undefined
          ? []
          : [
              ...inRoot(path.relative(repositoryRoot, ticketsDir)),
              ...inRoot(path.relative(realRoot, ticketsDir)),
              ...inRoot(path.relative(realRoot, yield* realPathOf(ticketsDir))),
            ];
      const isInQueue = (file: string) => queues.some((queue) => file === queue || file.startsWith(`${queue}/`));

      // The current branch, or `HEAD` when it is detached.
      const current = spawner
        .string(ChildProcess.make('git', ['branch', '--show-current'], { cwd: repositoryRoot }))
        .pipe(
          Effect.map((output): Worktree => ({ path: repositoryRoot, branch: output.trim() || 'HEAD', retained: false })),
          Effect.mapError(() => new WorktreeCreationError())
        );

      return {
        prepareProject: () => current,
        prepareTicket: () => current,
        mergeAndClose: () => Effect.void,
        runCommand: runCommandWith(spawner),
        // The changes `git status` lists, but the untracked files under the tickets
        // folder.
        changedPaths: (worktree) =>
          spawner.string(gitStatusIn(worktree.path)).pipe(
            Effect.map((porcelain) =>
              changesOf(porcelain)
                .filter((change) => !(change.untracked && isInQueue(change.path)))
                .map((change) => change.path)
            ),
            Effect.mapError(() => new WorktreeCommandError())
          ),
      };
    })
  );
