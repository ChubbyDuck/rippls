import { createWorktree } from '@ai-hero/sandcastle';
import { Console, Effect, Fiber, FileSystem, Layer, Option, Path, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';

import type { Project } from '~/Core/Tickets/Domain/Entities/Ticket/properties/Project';
import type { TicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';
import { WorktreeCloseError } from '~/Core/Tickets/Domain/Exceptions/WorktreeCloseError';
import { WorktreeCommandError } from '~/Core/Tickets/Domain/Exceptions/WorktreeCommandError';
import { WorktreeCreationError } from '~/Core/Tickets/Domain/Exceptions/WorktreeCreationError';
import { WorktreeNotExpected } from '~/Core/Tickets/Domain/Exceptions/WorktreeNotExpected';
import { type CommandRun, type Worktree, WorktreeManager } from '~/Core/Tickets/Ports/WorktreeManager';

import { ensureDependencies } from './ensureDependencies';

// Sandcastle stores a named-branch worktree at this path. A second createWorktree
// for the same branch fails because that branch is already checked out, so the
// adapter reuses the directory when it is already on disk: a Project Worktree,
// and a Ticket Worktree retained after an escalation. It reuses the directory
// only when it is a Git worktree on that branch. The adapter keeps no Sandcastle
// handle, so a Harness runs in a reused worktree as in a new one.
const worktreePathOf = (path: Path.Path, repositoryRoot: string, name: string) =>
  path.join(repositoryRoot, '.sandcastle', 'worktrees', name.replaceAll('/', '-'));

// The branch of a Ticket Worktree, named from the ticket identity with every
// character other than a letter, a digit, `_`, or `-` replaced by `-`. The
// identity of a folder ticket in a feature folder, such as `folder:auth/1`,
// gives `ticket-folder-auth-1`.
export const ticketBranchOf = (id: TicketId): string => `ticket-${id.replace(/[^A-Za-z0-9_-]/g, '-')}`;

// A command ended by its time limit gets this long to exit after the signal before
// it is killed.
const KILL_GRACE = '5 seconds';

// After the shell exits, its output is read for at most this long.
const OUTPUT_DRAIN = '1 second';

export const WorktreeManagerLive = (repositoryRoot: string) => {
  const projectMemo = new Map<string, Worktree>();
  const ticketMemo = new Map<string, { worktree: Worktree; parentPath: string }>();
  return Layer.effect(
    WorktreeManager,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const prepared = (worktreePath: string) =>
        ensureDependencies(worktreePath).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)
        );

      // Whether the path is on disk as the worktree of the Repository Root on the
      // branch. A path that holds anything else fails: it is never reused. Git
      // answers from the worktree that holds a directory, so a plain directory
      // under the Repository Root has the Repository Root as its top level, not
      // itself. A worktree of the Repository Root shares its Git directory.
      const isReusable = (onDisk: string, branch: string) =>
        Effect.gen(function* () {
          if (!(yield* fs.exists(onDisk))) {
            return false;
          }
          const unexpected = (found: string) => new WorktreeNotExpected({ path: onDisk, expectedBranch: branch, found });
          if ((yield* fs.stat(onDisk)).type !== 'Directory') {
            return yield* unexpected('not a directory');
          }
          const git = (args: readonly string[], cwd: string) =>
            spawner.string(ChildProcess.make('git', args, { cwd })).pipe(Effect.map((output) => output.trim()));
          const absolute = ['rev-parse', '--path-format=absolute'];
          const [topLevel, gitDirectory] = (yield* git([...absolute, '--show-toplevel', '--git-common-dir'], onDisk)).split('\n');
          if (topLevel !== (yield* fs.realPath(onDisk))) {
            return yield* unexpected('a directory that is not a Git worktree');
          }
          if (gitDirectory !== (yield* git([...absolute, '--git-common-dir'], repositoryRoot))) {
            return yield* unexpected('a Git worktree of another repository');
          }
          const current = yield* git(['branch', '--show-current'], onDisk);
          if (current !== branch) {
            return yield* unexpected(
              current === '' ? 'a Git worktree with a detached HEAD' : `a Git worktree on branch ${current}`
            );
          }
          return true;
        }).pipe(Effect.catchTag('PlatformError', () => Effect.fail(new WorktreeCreationError())));

      const prepareProject = (project: Project) =>
        Effect.gen(function* () {
          const cached = projectMemo.get(project);
          if (cached !== undefined) {
            yield* Console.log(`Worktree ${project} is reused at ${cached.path}`);
            return cached;
          }
          const onDisk = worktreePathOf(path, repositoryRoot, project);
          if (yield* isReusable(onDisk, project)) {
            yield* Console.log(`Worktree ${project} is reused from disk at ${onDisk}`);
            const worktree = { path: onDisk, branch: project };
            yield* prepared(worktree.path);
            projectMemo.set(project, worktree);
            return worktree;
          }
          yield* Console.log(`Worktree ${project} is creating from HEAD`);
          const created = yield* Effect.tryPromise({
            try: () =>
              createWorktree({
                cwd: repositoryRoot,
                branchStrategy: { type: 'branch', branch: project, baseBranch: 'HEAD' },
              }),
            catch: () => new WorktreeCreationError(),
          });
          const worktree = { path: created.worktreePath, branch: created.branch };
          yield* Console.log(`Worktree ${project} is ready at ${worktree.path} on branch ${worktree.branch}`);
          yield* prepared(worktree.path);
          projectMemo.set(project, worktree);
          return worktree;
        });

      return {
        prepareProject,
        prepareTicket: ({ id, project }: { readonly id: TicketId; readonly project?: Project }) =>
          Effect.gen(function* () {
            const branch = ticketBranchOf(id);
            const cached = ticketMemo.get(branch);
            if (cached !== undefined) {
              yield* Console.log(`Worktree ${branch} is reused at ${cached.worktree.path}`);
              return cached.worktree;
            }
            const parent =
              project === undefined ? { path: repositoryRoot, branch: 'HEAD' } : yield* prepareProject(project);
            const onDisk = worktreePathOf(path, repositoryRoot, branch);
            if (yield* isReusable(onDisk, branch)) {
              yield* Console.log(`Worktree ${branch} is reused from disk at ${onDisk}`);
              const worktree = { path: onDisk, branch };
              yield* prepared(worktree.path);
              ticketMemo.set(branch, { worktree, parentPath: parent.path });
              return worktree;
            }
            yield* Console.log(`Worktree ${branch} is creating from ${parent.branch} at ${parent.path}`);
            const created = yield* Effect.tryPromise({
              try: () =>
                createWorktree({
                  cwd: repositoryRoot,
                  branchStrategy: { type: 'branch', branch, baseBranch: parent.branch },
                }),
              catch: () => new WorktreeCreationError(),
            });
            const worktree = { path: created.worktreePath, branch: created.branch };
            yield* Console.log(`Worktree ${branch} is ready at ${worktree.path} on branch ${worktree.branch}`);
            yield* prepared(worktree.path);
            ticketMemo.set(branch, { worktree, parentPath: parent.path });
            return worktree;
          }),
        mergeAndClose: (worktree: Worktree) =>
          Effect.gen(function* () {
            const record = [...ticketMemo.values()].find((entry) => entry.worktree.path === worktree.path);
            if (record === undefined) {
              return;
            }
            const git = (args: readonly string[], cwd: string) =>
              spawner
                .string(ChildProcess.make('git', args, { cwd }))
                .pipe(Effect.mapError(() => new WorktreeCloseError()));
            // The exit code of a Git command in the directory the work merges into.
            // Its output is not read.
            const exitInParent = (args: readonly string[]) =>
              spawner
                .exitCode(
                  ChildProcess.make('git', args, {
                    cwd: record.parentPath,
                    stdin: 'ignore',
                    stdout: 'ignore',
                    stderr: 'ignore',
                  })
                )
                .pipe(Effect.mapError(() => new WorktreeCloseError()));
            yield* Console.log(`Worktree ${worktree.branch} is merging into ${record.parentPath}`);
            // A merge already in progress there is a person's: it is left as it
            // is, and no merge starts.
            if ((yield* exitInParent(['rev-parse', '--quiet', '--verify', 'MERGE_HEAD'])) === 0) {
              return yield* new WorktreeCloseError();
            }
            // A merge that exits non-zero, as on a conflict, is aborted, so the
            // directory it merges into is left as it was.
            if ((yield* exitInParent(['merge', '--no-ff', '--no-edit', worktree.branch])) !== 0) {
              yield* exitInParent(['merge', '--abort']).pipe(Effect.ignore);
              return yield* new WorktreeCloseError();
            }
            yield* Console.log(`Worktree ${worktree.branch} is closing at ${worktree.path}`);
            // As a Sandcastle handle closes it, once the work is merged: a
            // worktree with uncommitted changes stays on disk, and a failure to
            // remove a worktree is ignored.
            yield* git(['status', '--porcelain'], worktree.path).pipe(
              Effect.flatMap((changes) =>
                changes.trim().length === 0
                  ? git(['worktree', 'remove', '--force', worktree.path], repositoryRoot)
                  : Effect.void
              ),
              Effect.ignore
            );
            ticketMemo.delete(worktree.branch);
            yield* Console.log(`Worktree ${worktree.branch} is closed`);
          }),
        // The command runs through `sh -c` with no input. Its output is kept as it
        // arrives, so a command ended by the time limit still returns what it wrote.
        // The verdict is the exit of the shell: a process the command leaves behind
        // with the output open does not hold it up, and its output is read only for a
        // short while after. Closing the scope ends the process group of the shell,
        // with every process the command started, and kills a process that ignores
        // the signal after a short while.
        runCommand: ({ worktree, command, timeLimit }) =>
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
          ).pipe(Effect.mapError(() => new WorktreeCommandError())),
        // Clean is an empty `git status`. Untracked files are listed one by one
        // whatever `status.showUntrackedFiles` says, and ignored files never are.
        isClean: (worktree: Worktree) =>
          spawner
            .string(ChildProcess.make('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: worktree.path }))
            .pipe(
              Effect.map((changes) => changes.trim().length === 0),
              Effect.mapError(() => new WorktreeCommandError())
            ),
      };
    })
  );
};
