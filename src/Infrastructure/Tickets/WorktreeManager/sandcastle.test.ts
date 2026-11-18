import { createWorktree, run as runSandcastle } from '@ai-hero/sandcastle';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { Clock, Console, type Duration, Effect, FileSystem, Layer, Path, type PlatformError, Schema } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { beforeEach, expect, test, vi } from 'vitest';

import { Project } from '~/Core/Tickets/Domain/Entities/Ticket/properties/Project';
import { TicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';
import { WorktreeManager } from '~/Core/Tickets/Ports/WorktreeManager';
import { registeredHarnessesOf } from '~/Infrastructure/Shared/HarnessSelector/registered';

import { WorktreeManagerLive } from './sandcastle';

vi.mock('@ai-hero/sandcastle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ai-hero/sandcastle')>();
  return {
    ...actual,
    createWorktree: vi.fn(actual.createWorktree),
    run: vi.fn(),
  };
});

const createWorktreeMock = vi.mocked(createWorktree);
const runMock = vi.mocked(runSandcastle);

const project = Schema.decodeSync(Project)('demo');
const ticketId = Schema.decodeSync(TicketId)('folder:17');
const authTicket = Schema.decodeSync(TicketId)('folder:auth/1');
const billingTicket = Schema.decodeSync(TicketId)('folder:billing/plans/1');

const git = (dir: string, args: string[]) =>
  ChildProcessSpawner.ChildProcessSpawner.pipe(
    Effect.flatMap((spawner) => spawner.string(ChildProcess.make('git', args, { cwd: dir }))),
    Effect.map((output) => output.trim())
  );

const initRepo = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectory({ prefix: 'engine-worktree-' });
  yield* git(dir, ['init', '-b', 'main']);
  yield* git(dir, ['config', 'user.email', 'test@test.com']);
  yield* git(dir, ['config', 'user.name', 'Test']);
  yield* fs.writeFileString(path.join(dir, 'base.txt'), 'from main');
  yield* git(dir, ['add', 'base.txt']);
  yield* git(dir, ['commit', '-m', 'init']);
  return dir;
});

const prepareProject = (root: string) =>
  WorktreeManager.pipe(
    Effect.flatMap((manager) => manager.prepareProject(project)),
    Effect.provide(WorktreeManagerLive(root))
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
  runMock.mockReset();
});

test('the first call for a project creates its branch off the base and a worktree', async () => {
  const worktree = await run(
    Effect.gen(function* () {
      const root = yield* initRepo;
      return yield* prepareProject(root);
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
      const obtain = prepareProject(root);
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
      const first = yield* prepareProject(root);
      createWorktreeMock.mockClear();
      const second = yield* prepareProject(root);
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
      return yield* prepareProject(root);
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
        const manager = yield* WorktreeManager;
        const projectTree = yield* manager.prepareProject(project);
        const ticketTree = yield* manager.prepareTicket({ id: ticketId, project });
        return { projectTree, ticketTree };
      }).pipe(Effect.provide(WorktreeManagerLive(root)));
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
        const manager = yield* WorktreeManager;
        return yield* manager.prepareTicket({ id: ticketId });
      }).pipe(Effect.provide(WorktreeManagerLive(root)));
    })
  );

  expect(worktree.branch).toBe('ticket-folder-17');
  expect(await run(git(worktree.path, ['rev-parse', '--abbrev-ref', 'HEAD']))).toBe('ticket-folder-17');
});

test('the same number in two feature folders gets two branches and two Ticket Worktrees', async () => {
  const { auth, billing } = await run(
    Effect.gen(function* () {
      const root = yield* initRepo;
      return yield* Effect.gen(function* () {
        const manager = yield* WorktreeManager;
        const auth = yield* manager.prepareTicket({ id: authTicket });
        const billing = yield* manager.prepareTicket({ id: billingTicket });
        return { auth, billing };
      }).pipe(Effect.provide(WorktreeManagerLive(root)));
    })
  );

  expect([auth.branch, billing.branch]).toEqual(['ticket-folder-auth-1', 'ticket-folder-billing-plans-1']);
  expect(auth.path).not.toBe(billing.path);
  expect(await run(git(auth.path, ['rev-parse', '--abbrev-ref', 'HEAD']))).toBe('ticket-folder-auth-1');
  expect(await run(git(billing.path, ['rev-parse', '--abbrev-ref', 'HEAD']))).toBe('ticket-folder-billing-plans-1');
});

test('a second prepareTicket for the same ticket returns the same worktree without a second create', async () => {
  const { first, second } = await run(
    Effect.gen(function* () {
      const root = yield* initRepo;
      return yield* Effect.gen(function* () {
        const manager = yield* WorktreeManager;
        const first = yield* manager.prepareTicket({ id: ticketId });
        createWorktreeMock.mockClear();
        const second = yield* manager.prepareTicket({ id: ticketId });
        return { first, second };
      }).pipe(Effect.provide(WorktreeManagerLive(root)));
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
        const manager = yield* WorktreeManager;
        const projectTree = yield* manager.prepareProject(project);
        const ticketTree = yield* manager.prepareTicket({ id: ticketId, project });
        yield* manager.prepareProject(project);
        yield* manager.prepareTicket({ id: ticketId, project });
        yield* manager.mergeAndClose(ticketTree);
        return { projectTree, ticketTree };
      }).pipe(Effect.provide(WorktreeManagerLive(root)));
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
        const manager = yield* WorktreeManager;
        const projectTree = yield* manager.prepareProject(project);
        const ticketTree = yield* manager.prepareTicket({ id: ticketId, project });
        yield* fs.writeFileString(path.join(ticketTree.path, 'feat.txt'), 'from ticket');
        yield* git(ticketTree.path, ['add', 'feat.txt']);
        yield* git(ticketTree.path, ['commit', '-m', 'feat']);
        yield* manager.mergeAndClose(ticketTree);
        return {
          projectTree,
          ticketPath: ticketTree.path,
          exists: yield* fs.exists(ticketTree.path),
          feature: yield* git(projectTree.path, ['show', 'HEAD:feat.txt']),
        };
      }).pipe(Effect.provide(WorktreeManagerLive(root)));
    })
  );

  expect(exists).toBe(false);
  expect(feature).toBe('from ticket');
  expect(await run(git(projectTree.path, ['rev-parse', '--abbrev-ref', 'HEAD']))).toBe('demo');
  expect((await run(git(projectTree.path, ['log', '-1', '--format=%P']))).split(' ')).toHaveLength(2);
  expect(ticketPath).toContain('ticket-folder-17');
});


test('a Ticket Worktree on disk is reused by a new manager, and a Harness run, merge, and close work on it', async () => {
  // The Agent commits everything in the directory it runs in.
  runMock.mockImplementation((options) =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = options.cwd!;
        yield* fs.writeFileString(path.join(cwd, 'agent.txt'), 'from the agent');
        yield* git(cwd, ['add', '-A']);
        yield* git(cwd, ['commit', '-m', 'agent']);
        return { completionSignal: undefined, iterations: [], stdout: '', commits: [], branch: 'ticket-folder-17' };
      })
    )
  );
  const result = await run(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* initRepo;
      const prepareTicket = WorktreeManager.pipe(Effect.flatMap((manager) => manager.prepareTicket({ id: ticketId })));
      // An earlier Engine run prepares the Ticket Worktree, commits work, and is
      // escalated; a human then leaves a fix uncommitted.
      const first = yield* prepareTicket.pipe(Effect.provide(WorktreeManagerLive(root)));
      yield* fs.writeFileString(path.join(first.path, 'earlier.txt'), 'earlier work');
      yield* git(first.path, ['add', 'earlier.txt']);
      yield* git(first.path, ['commit', '-m', 'earlier work']);
      yield* fs.writeFileString(path.join(first.path, 'base.txt'), 'fixed by a human');
      createWorktreeMock.mockClear();
      return yield* Effect.gen(function* () {
        const manager = yield* WorktreeManager;
        const reused = yield* manager.prepareTicket({ id: ticketId });
        const earlierLog = yield* git(reused.path, ['log', '--format=%s']);
        const uncommitted = yield* git(reused.path, ['status', '--porcelain']);
        const { Claude } = registeredHarnessesOf(root, path);
        yield* Claude.run('continue the work', { label: 'ticket-folder-17', cwd: reused.path });
        yield* manager.mergeAndClose(reused);
        return {
          first,
          reused,
          earlierLog,
          uncommitted,
          exists: yield* fs.exists(reused.path),
          merged: {
            earlier: yield* git(root, ['show', 'HEAD:earlier.txt']),
            fix: yield* git(root, ['show', 'HEAD:base.txt']),
            agent: yield* git(root, ['show', 'HEAD:agent.txt']),
          },
        };
      }).pipe(Effect.provide(WorktreeManagerLive(root)));
    })
  );

  expect(result.reused).toEqual(result.first);
  expect(createWorktreeMock).not.toHaveBeenCalled();
  expect(result.earlierLog.split('\n')).toEqual(['earlier work', 'init']);
  expect(result.uncommitted).toBe('M base.txt');
  expect(runMock).toHaveBeenCalledTimes(1);
  expect(runMock.mock.calls[0]?.[0]).toMatchObject({ prompt: 'continue the work', cwd: result.reused.path });
  expect(result.merged).toEqual({ earlier: 'earlier work', fix: 'fixed by a human', agent: 'from the agent' });
  expect(result.exists).toBe(false);
});

// Prepares the Ticket Worktree of `folder:17` in a new repository, and runs a
// command in it with the given time limit.
const runInTicketWorktree = (command: string, timeLimit: Duration.Input = '10 seconds') =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* initRepo;
    return yield* Effect.gen(function* () {
      const manager = yield* WorktreeManager;
      const worktree = yield* manager.prepareTicket({ id: ticketId });
      const outcome = yield* manager.runCommand({ worktree, command, timeLimit });
      return { worktree: { ...worktree, path: yield* fs.realPath(worktree.path) }, outcome };
    }).pipe(Effect.provide(WorktreeManagerLive(root)));
  });

test('runCommand runs a compound shell command in the worktree directory and returns its exit code and output', async () => {
  const { worktree, outcome } = await run(
    runInTicketWorktree('pwd && cat base.txt && echo " to stdout" && echo to stderr >&2; exit 3')
  );

  expect(outcome).toEqual({
    _tag: 'Exited',
    exitCode: 3,
    output: `${worktree.path}\nfrom main to stdout\nto stderr\n`,
  });
});

test('runCommand returns exit code zero for a passing command', async () => {
  const { outcome } = await run(runInTicketWorktree('true'));

  expect(outcome).toEqual({ _tag: 'Exited', exitCode: 0, output: '' });
});

test('runCommand ends a command at its time limit, with every process it started, and returns the output so far', async () => {
  const { elapsed, outcome, lateFileWritten } = await run(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const started = yield* Clock.currentTimeMillis;
      const { worktree, outcome } = yield* runInTicketWorktree('echo started; sleep 1 && touch late.txt', '300 millis');
      const elapsed = (yield* Clock.currentTimeMillis) - started;
      yield* Effect.sleep('1500 millis');
      return { elapsed, outcome, lateFileWritten: yield* fs.exists(`${worktree.path}/late.txt`) };
    })
  );

  expect(elapsed).toBeLessThan(1000);
  expect(outcome).toEqual({ _tag: 'TimedOut', output: 'started\n' });
  expect(lateFileWritten).toBe(false);
});

test('runCommand ends a command that ignores the signal of its time limit', { timeout: 15_000 }, async () => {
  const { elapsed, outcome } = await run(
    Effect.gen(function* () {
      const started = yield* Clock.currentTimeMillis;
      const { outcome } = yield* runInTicketWorktree("trap '' TERM; echo started; sleep 30", '300 millis');
      return { elapsed: (yield* Clock.currentTimeMillis) - started, outcome };
    })
  );

  expect(elapsed).toBeLessThan(10_000);
  expect(outcome).toEqual({ _tag: 'TimedOut', output: 'started\n' });
});

test('runCommand takes the exit of the shell as the verdict when the command leaves a process with the output open', async () => {
  const { elapsed, outcome } = await run(
    Effect.gen(function* () {
      const started = yield* Clock.currentTimeMillis;
      const { outcome } = yield* runInTicketWorktree('(sleep 5; echo late) & echo passed', '3 seconds');
      return { elapsed: (yield* Clock.currentTimeMillis) - started, outcome };
    })
  );

  expect(elapsed).toBeLessThan(3000);
  expect(outcome).toEqual({ _tag: 'Exited', exitCode: 0, output: 'passed\n' });
});

// Prepares the Ticket Worktree of `folder:17` in a new repository whose `.gitignore`
// ignores `*.log`, changes it with `change`, and tells whether it is clean.
const cleanAfter = (
  change: (worktree: string) => Effect.Effect<void, PlatformError.PlatformError, NodeServices.NodeServices>
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* initRepo;
    yield* fs.writeFileString(path.join(root, '.gitignore'), '*.log\n');
    yield* git(root, ['add', '.gitignore']);
    yield* git(root, ['commit', '-m', 'ignore logs']);
    return yield* Effect.gen(function* () {
      const manager = yield* WorktreeManager;
      const worktree = yield* manager.prepareTicket({ id: ticketId });
      yield* change(worktree.path);
      return yield* manager.isClean(worktree);
    }).pipe(Effect.provide(WorktreeManagerLive(root)));
  });

const writeIn = (worktree: string, file: string, content: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.writeFileString(path.join(worktree, file), content);
  });

test('isClean tells a fresh Ticket Worktree, and one whose work is committed, clean', async () => {
  expect(await run(cleanAfter(() => Effect.void))).toBe(true);
  expect(
    await run(
      cleanAfter((worktree) =>
        writeIn(worktree, 'feat.txt', 'work').pipe(
          Effect.andThen(git(worktree, ['add', 'feat.txt'])),
          Effect.andThen(git(worktree, ['commit', '-m', 'feat'])),
          Effect.asVoid
        )
      )
    )
  ).toBe(true);
});

test('isClean tells a Ticket Worktree with a modified file dirty', async () => {
  expect(await run(cleanAfter((worktree) => writeIn(worktree, 'base.txt', 'changed')))).toBe(false);
});

test('isClean tells a Ticket Worktree with an untracked file dirty, even in a new folder', async () => {
  expect(await run(cleanAfter((worktree) => writeIn(worktree, 'new.txt', 'new')))).toBe(false);
  expect(
    await run(
      cleanAfter((worktree) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* fs.makeDirectory(`${worktree}/src`);
          yield* writeIn(worktree, 'src/new.txt', 'new');
          yield* git(worktree, ['config', 'status.showUntrackedFiles', 'no']);
        })
      )
    )
  ).toBe(false);
});

test('isClean tells a Ticket Worktree with only an ignored file clean', async () => {
  expect(await run(cleanAfter((worktree) => writeIn(worktree, 'debug.log', 'noise')))).toBe(true);
});
