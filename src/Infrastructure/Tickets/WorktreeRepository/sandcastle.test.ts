import { createWorktree } from '@ai-hero/sandcastle';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { Console, Effect, FileSystem, Layer, Path, Schema } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { beforeEach, expect, test, vi } from 'vitest';

import { Project } from '~/Core/Tickets/Domain/Entities/Ticket/properties/Project';
import { TicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';
import { WorktreeRepository } from '~/Core/Tickets/Ports/WorktreeRepository';

import { clearTicketHandles, WorktreeRepositoryLive } from './sandcastle';

vi.mock('@ai-hero/sandcastle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ai-hero/sandcastle')>();
  return {
    ...actual,
    createWorktree: vi.fn(actual.createWorktree),
  };
});

const createWorktreeMock = vi.mocked(createWorktree);

const project = Schema.decodeSync(Project)('demo');
const ticketId = Schema.decodeSync(TicketId)('folder:17');

const git = (dir: string, args: string[]) =>
  ChildProcessSpawner.ChildProcessSpawner.pipe(
    Effect.flatMap((spawner) => spawner.string(ChildProcess.make('git', args, { cwd: dir }))),
    Effect.map((output) => output.trim())
  );

const initRepo = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectory({ prefix: 'harness-worktree-' });
  yield* git(dir, ['init', '-b', 'main']);
  yield* git(dir, ['config', 'user.email', 'test@test.com']);
  yield* git(dir, ['config', 'user.name', 'Test']);
  yield* fs.writeFileString(path.join(dir, 'base.txt'), 'from main');
  yield* git(dir, ['add', 'base.txt']);
  yield* git(dir, ['commit', '-m', 'init']);
  return dir;
});

const projectAnchor = (root: string) =>
  WorktreeRepository.pipe(
    Effect.flatMap((repo) => repo.projectAnchor(project)),
    Effect.provide(WorktreeRepositoryLive(root))
  );

const capturingConsole = (messages: string[]): Console.Console =>
  Object.assign(Object.create(console), {
    log: (...args: ReadonlyArray<unknown>) => {
      messages.push(args.map(String).join(' '));
    },
  });

const run = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices>, messages?: string[]) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        messages === undefined
          ? NodeServices.layer
          : Layer.mergeAll(NodeServices.layer, Layer.succeed(Console.Console, capturingConsole(messages)))
      )
    )
  );

beforeEach(() => {
  createWorktreeMock.mockClear();
  clearTicketHandles();
});

test('the first call for a project creates its branch off the base and a worktree', async () => {
  const worktree = await run(
    Effect.gen(function* () {
      const root = yield* initRepo;
      return yield* projectAnchor(root);
    })
  );

  expect(worktree.branch).toBe('demo');
  expect(await run(git(worktree.path, ['rev-parse', '--abbrev-ref', 'HEAD']))).toBe('demo');
  expect(await run(git(worktree.path, ['merge-base', 'demo', 'main']))).toBe(
    await run(git(worktree.path, ['rev-parse', 'main']))
  );
  expect(await run(git(worktree.path, ['show', 'HEAD:base.txt']))).toBe('from main');
});

test('a second call for the same project returns the same worktree without a second create', async () => {
  const { first, second } = await run(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* initRepo;
      const obtain = projectAnchor(root);
      const first = yield* obtain;
      createWorktreeMock.mockClear();
      yield* fs.remove(first.path, { recursive: true });
      const second = yield* obtain;
      return { first, second };
    })
  );

  expect(second).toEqual(first);
  expect(createWorktreeMock).not.toHaveBeenCalled();
});

test('an existing on-disk project worktree is reused without a second create', async () => {
  const { first, second, exists } = await run(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* initRepo;
      const first = yield* projectAnchor(root);
      createWorktreeMock.mockClear();
      const second = yield* projectAnchor(root);
      return { first, second, exists: yield* fs.exists(second.path) };
    })
  );

  expect(second.path).toBe(first.path);
  expect(second.branch).toBe('demo');
  expect(exists).toBe(true);
  expect(createWorktreeMock).not.toHaveBeenCalled();
});

test('an existing project branch is reused without error', async () => {
  const worktree = await run(
    Effect.gen(function* () {
      const root = yield* initRepo;
      yield* git(root, ['branch', 'demo']);
      return yield* projectAnchor(root);
    })
  );

  expect(worktree.branch).toBe('demo');
  expect(await run(git(worktree.path, ['rev-parse', '--abbrev-ref', 'HEAD']))).toBe('demo');
  expect(await run(git(worktree.path, ['rev-parse', 'HEAD']))).toBe(await run(git(worktree.path, ['rev-parse', 'demo'])));
});

test('a ticket worktree is created from the project branch', async () => {
  const { projectTree, ticketTree } = await run(
    Effect.gen(function* () {
      const root = yield* initRepo;
      return yield* Effect.gen(function* () {
        const repo = yield* WorktreeRepository;
        const projectTree = yield* repo.projectAnchor(project);
        const ticketTree = yield* repo.ticketAnchor({ id: ticketId, project });
        return { projectTree, ticketTree };
      }).pipe(Effect.provide(WorktreeRepositoryLive(root)));
    })
  );

  expect(ticketTree.branch).toBe('ticket-folder-17');
  expect(ticketTree.path).not.toBe(projectTree.path);
  expect(await run(git(ticketTree.path, ['rev-parse', '--abbrev-ref', 'HEAD']))).toBe('ticket-folder-17');
  expect(await run(git(ticketTree.path, ['merge-base', 'ticket-folder-17', 'demo']))).toBe(
    await run(git(projectTree.path, ['rev-parse', 'demo']))
  );
});

test('a ticket without a project is created from HEAD', async () => {
  const worktree = await run(
    Effect.gen(function* () {
      const root = yield* initRepo;
      return yield* Effect.gen(function* () {
        const repo = yield* WorktreeRepository;
        return yield* repo.ticketAnchor({ id: ticketId });
      }).pipe(Effect.provide(WorktreeRepositoryLive(root)));
    })
  );

  expect(worktree.branch).toBe('ticket-folder-17');
  expect(await run(git(worktree.path, ['rev-parse', '--abbrev-ref', 'HEAD']))).toBe('ticket-folder-17');
});

test('a second ticketAnchor for the same ticket returns the same worktree without a second create', async () => {
  const { first, second } = await run(
    Effect.gen(function* () {
      const root = yield* initRepo;
      return yield* Effect.gen(function* () {
        const repo = yield* WorktreeRepository;
        const first = yield* repo.ticketAnchor({ id: ticketId });
        createWorktreeMock.mockClear();
        const second = yield* repo.ticketAnchor({ id: ticketId });
        return { first, second };
      }).pipe(Effect.provide(WorktreeRepositoryLive(root)));
    })
  );

  expect(second).toEqual(first);
  expect(createWorktreeMock).not.toHaveBeenCalled();
});

test('narrates creating, reusing, installing, and closing worktrees', async () => {
  const messages: string[] = [];
  const { projectTree, ticketTree } = await run(
    Effect.gen(function* () {
      const root = yield* initRepo;
      return yield* Effect.gen(function* () {
        const repo = yield* WorktreeRepository;
        const projectTree = yield* repo.projectAnchor(project);
        const ticketTree = yield* repo.ticketAnchor({ id: ticketId, project });
        yield* repo.projectAnchor(project);
        yield* repo.ticketAnchor({ id: ticketId, project });
        yield* repo.close(ticketTree);
        return { projectTree, ticketTree };
      }).pipe(Effect.provide(WorktreeRepositoryLive(root)));
    }),
    messages
  );

  expect(messages).toEqual([
    'Worktree demo is creating from HEAD',
    `Worktree demo is ready at ${projectTree.path} on branch demo`,
    `Dependencies are skipped at ${projectTree.path} (no package.json)`,
    `Worktree demo is reused at ${projectTree.path}`,
    `Worktree ticket-folder-17 is creating from demo at ${projectTree.path}`,
    `Worktree ticket-folder-17 is ready at ${ticketTree.path} on branch ticket-folder-17`,
    `Dependencies are skipped at ${ticketTree.path} (no package.json)`,
    `Worktree demo is reused at ${projectTree.path}`,
    `Worktree ticket-folder-17 is reused at ${ticketTree.path}`,
    `Worktree ticket-folder-17 is merging into ${projectTree.path}`,
    `Worktree ticket-folder-17 is closing at ${ticketTree.path}`,
    'Worktree ticket-folder-17 is closed',
  ]);
});

test('closing a ticket worktree merges it into the project and removes the tree', async () => {
  const { projectTree, ticketPath, exists, feature } = await run(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* initRepo;
      return yield* Effect.gen(function* () {
        const repo = yield* WorktreeRepository;
        const projectTree = yield* repo.projectAnchor(project);
        const ticketTree = yield* repo.ticketAnchor({ id: ticketId, project });
        yield* fs.writeFileString(path.join(ticketTree.path, 'feat.txt'), 'from ticket');
        yield* git(ticketTree.path, ['add', 'feat.txt']);
        yield* git(ticketTree.path, ['commit', '-m', 'feat']);
        yield* repo.close(ticketTree);
        return {
          projectTree,
          ticketPath: ticketTree.path,
          exists: yield* fs.exists(ticketTree.path),
          feature: yield* git(projectTree.path, ['show', 'HEAD:feat.txt']),
        };
      }).pipe(Effect.provide(WorktreeRepositoryLive(root)));
    })
  );

  expect(exists).toBe(false);
  expect(feature).toBe('from ticket');
  expect(await run(git(projectTree.path, ['rev-parse', '--abbrev-ref', 'HEAD']))).toBe('demo');
  expect((await run(git(projectTree.path, ['log', '-1', '--format=%P']))).split(' ')).toHaveLength(2);
  expect(ticketPath).toContain('ticket-folder-17');
});

