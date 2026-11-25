import { Effect, Fiber, Option, Stream } from 'effect';
import { ChildProcess, type ChildProcessSpawner } from 'effect/unstable/process';

import { WorktreeCommandError } from '~/Core/Tickets/Domain/Exceptions/WorktreeCommandError';
import type { CommandRun, WorktreeManager } from '~/Core/Tickets/Ports/WorktreeManager';

// A command ended by its time limit gets this long to exit after the signal before
// it is killed.
const KILL_GRACE = '5 seconds';

// After the shell exits, its output is read for at most this long.
const OUTPUT_DRAIN = '1 second';

// The command runs through `sh -c` with no input. Its output is kept as it
// arrives, so a command ended by the time limit still returns what it wrote.
// The verdict is the exit of the shell: a process the command leaves behind
// with the output open does not hold it up, and its output is read only for a
// short while after. Closing the scope ends the process group of the shell,
// with every process the command started, and kills a process that ignores
// the signal after a short while.
export const runCommandWith =
  (spawner: ChildProcessSpawner.ChildProcessSpawner['Service']): WorktreeManager['Service']['runCommand'] =>
  ({ worktree, command, timeLimit }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const chunks: string[] = [];
        const handle = yield* spawner.spawn(
          ChildProcess.make('sh', ['-c', command], {
            cwd: worktree.path,
            stdin: 'ignore',
            forceKillAfter: KILL_GRACE,
          })
        );
        const reading = yield* handle.all.pipe(
          Stream.decodeText(),
          Stream.runForEach((chunk) => Effect.sync(() => chunks.push(chunk))),
          Effect.forkScoped
        );
        const exited = yield* handle.exitCode.pipe(Effect.timeoutOption(timeLimit));
        if (Option.isSome(exited)) {
          yield* Fiber.join(reading).pipe(Effect.timeoutOption(OUTPUT_DRAIN));
        }
        const output = chunks.join('');
        return Option.match(exited, {
          onNone: (): CommandRun => ({ _tag: 'TimedOut', output }),
          onSome: (exitCode): CommandRun => ({ _tag: 'Exited', exitCode, output }),
        });
      })
    ).pipe(Effect.mapError(() => new WorktreeCommandError()));
