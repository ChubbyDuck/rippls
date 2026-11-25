import { Effect, FileSystem, Layer, Path } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';

import { WorktreeCommandError } from '~/Core/Tickets/Domain/Exceptions/WorktreeCommandError';
import { WorktreeCreationError } from '~/Core/Tickets/Domain/Exceptions/WorktreeCreationError';
import { type Worktree, WorktreeManager } from '~/Core/Tickets/Ports/WorktreeManager';

import { runCommandWith } from './runCommand';

// The paths `git status --porcelain -z` lists as changed, with the untracked ones
// apart. A rename or a copy is followed by the path it came from, which is skipped:
// the path it went to stands for the change.
const changesOf = (porcelain: string) => {
  const fields = porcelain.split('\0');
  const changes: Array<{ readonly path: string; readonly untracked: boolean }> = [];
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index] ?? '';
    if (field.length < 4) {
      continue;
    }
    const status = field.slice(0, 2);
    changes.push({ path: field.slice(3), untracked: status === '??' });
    if (status.includes('R') || status.includes('C')) {
      index++;
    }
  }
  return changes;
};

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
        // Clean is a `git status` with no change but the untracked files under the
        // tickets folder. Untracked files are listed one by one whatever
        // `status.showUntrackedFiles` says, and ignored files never are.
        isClean: (worktree: Worktree) =>
          spawner
            .string(
              ChildProcess.make('git', ['status', '--porcelain', '-z', '--untracked-files=all'], { cwd: worktree.path })
            )
            .pipe(
              Effect.map((porcelain) => changesOf(porcelain).every((change) => change.untracked && isInQueue(change.path))),
              Effect.mapError(() => new WorktreeCommandError())
            ),
      };
    })
  );
