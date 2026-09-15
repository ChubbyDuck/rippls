import { Console, Effect, FileSystem, Path } from 'effect';

import { WorktreesNotWritable } from '~/Core/Tickets/Domain/Exceptions/WorktreesNotWritable';

export const ensureWorktreesWritable = (root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const worktrees = path.join(root, '.sandcastle', 'worktrees');
    if (!(yield* fs.exists(worktrees))) {
      yield* Console.log(`Worktrees directory is creating at ${worktrees}`);
      yield* fs.makeDirectory(worktrees, { recursive: true });
      yield* Console.log(`Worktrees directory is ready at ${worktrees}`);
      return;
    }
    if (yield* Effect.isSuccess(fs.access(worktrees, { writable: true }))) {
      return;
    }
    const error = new WorktreesNotWritable({ path: yield* fs.realPath(worktrees) });
    yield* Console.error(error.message);
    return yield* error;
  });
