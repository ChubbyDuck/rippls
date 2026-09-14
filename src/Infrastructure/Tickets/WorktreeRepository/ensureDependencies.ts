import { Console, Effect, FileSystem, Path } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';

import { WorktreeCreationError } from '~/Core/Tickets/Domain/Exceptions/WorktreeCreationError';

// A git worktree does not carry ignored files. The Agent must be able to run
// package scripts immediately, so the harness installs from the worktree's own
// manifest before any Agent starts. Skip trees with no manifest, and trees that
// already have node_modules.
export const ensureDependencies = (worktreePath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const exists = (target: string) => fs.exists(target).pipe(Effect.mapError(() => new WorktreeCreationError()));
    if (!(yield* exists(path.join(worktreePath, 'package.json')))) {
      yield* Console.log(`Dependencies are skipped at ${worktreePath} (no package.json)`);
      return;
    }
    if (yield* exists(path.join(worktreePath, 'node_modules'))) {
      yield* Console.log(`Dependencies are already present at ${worktreePath}`);
      return;
    }
    yield* Console.log(`Dependencies are installing with corepack pnpm install at ${worktreePath}`);
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    yield* spawner
      .string(ChildProcess.make('corepack', ['pnpm', 'install'], { cwd: worktreePath }))
      .pipe(Effect.mapError(() => new WorktreeCreationError()));
    yield* Console.log(`Dependencies are ready at ${worktreePath}`);
  });
