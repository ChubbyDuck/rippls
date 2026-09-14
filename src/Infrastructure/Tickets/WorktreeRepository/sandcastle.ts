import { createWorktree, type Worktree as SandcastleWorktree } from '@ai-hero/sandcastle';
import { Console, Effect, FileSystem, Layer, Path } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';

import type { Project } from '~/Core/Tickets/Domain/Entities/Ticket/properties/Project';
import type { TicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';
import { WorktreeCloseError } from '~/Core/Tickets/Domain/Exceptions/WorktreeCloseError';
import { WorktreeCreationError } from '~/Core/Tickets/Domain/Exceptions/WorktreeCreationError';
import { type Worktree, WorktreeRepository } from '~/Core/Tickets/Ports/WorktreeRepository';

import { ensureDependencies } from './ensureDependencies';

// Sandcastle stores a named-branch worktree at this path. A second createWorktree
// for the same branch fails because that branch is already checked out, so the
// adapter reuses the directory when it is already on disk. The handle is never
// closed: the project worktree is the accumulation point.
const worktreePathOf = (path: Path.Path, repositoryRoot: string, name: string) =>
  path.join(repositoryRoot, '.sandcastle', 'worktrees', name.replaceAll('/', '-'));

const ticketHandles = new Map<string, SandcastleWorktree>();

export const registerTicketHandle = (worktreePath: string, handle: SandcastleWorktree) => {
  ticketHandles.set(worktreePath, handle);
};

export const getTicketHandle = (worktreePath: string) => ticketHandles.get(worktreePath);

export const unregisterTicketHandle = (worktreePath: string) => {
  ticketHandles.delete(worktreePath);
};

export const clearTicketHandles = () => {
  ticketHandles.clear();
};

export const WorktreeRepositoryLive = (repositoryRoot: string) => {
  const projectMemo = new Map<string, Worktree>();
  const ticketMemo = new Map<string, { worktree: Worktree; parentPath: string }>();
  return Layer.effect(
    WorktreeRepository,
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

      const projectAnchor = (project: Project) =>
        Effect.gen(function* () {
          const cached = projectMemo.get(project);
          if (cached !== undefined) {
            yield* Console.log(`Worktree ${project} is reused at ${cached.path}`);
            return cached;
          }
          const onDisk = worktreePathOf(path, repositoryRoot, project);
          if (yield* fs.exists(onDisk).pipe(Effect.mapError(() => new WorktreeCreationError()))) {
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
        projectAnchor,
        ticketAnchor: ({ id, project }: { readonly id: TicketId; readonly project?: Project }) =>
          Effect.gen(function* () {
            const branch = `ticket-${id.replaceAll(':', '-')}`;
            const cached = ticketMemo.get(branch);
            if (cached !== undefined) {
              yield* Console.log(`Worktree ${branch} is reused at ${cached.worktree.path}`);
              return cached.worktree;
            }
            const parent =
              project === undefined ? { path: repositoryRoot, branch: 'HEAD' } : yield* projectAnchor(project);
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
            registerTicketHandle(created.worktreePath, created);
            ticketMemo.set(branch, { worktree, parentPath: parent.path });
            return worktree;
          }),
        close: (worktree: Worktree) =>
          Effect.gen(function* () {
            const record = [...ticketMemo.values()].find((entry) => entry.worktree.path === worktree.path);
            const handle = getTicketHandle(worktree.path);
            if (record === undefined || handle === undefined) {
              return;
            }
            yield* Console.log(`Worktree ${worktree.branch} is merging into ${record.parentPath}`);
            yield* spawner
              .string(
                ChildProcess.make('git', ['merge', '--no-ff', '--no-edit', worktree.branch], {
                  cwd: record.parentPath,
                })
              )
              .pipe(Effect.mapError(() => new WorktreeCloseError()));
            yield* Console.log(`Worktree ${worktree.branch} is closing at ${worktree.path}`);
            yield* Effect.tryPromise({
              try: () => handle.close(),
              catch: () => new WorktreeCloseError(),
            });
            unregisterTicketHandle(worktree.path);
            ticketMemo.delete(worktree.branch);
            yield* Console.log(`Worktree ${worktree.branch} is closed`);
          }),
      };
    })
  );
};
