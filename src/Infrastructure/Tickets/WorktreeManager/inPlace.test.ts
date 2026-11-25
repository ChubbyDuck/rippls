import * as NodeServices from '@effect/platform-node/NodeServices';
import { ConfigProvider, Effect, FileSystem, Layer, Path, Schema } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { expect, test } from 'vitest';

import { RepositoryRoot } from '~/Core/Shared/Domain/RepositoryRoot';
import { Project } from '~/Core/Tickets/Domain/Entities/Ticket/properties/Project';
import { formatTicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';
import { TicketSource } from '~/Core/Tickets/Ports/TicketSource';
import { WorktreeManager } from '~/Core/Tickets/Ports/WorktreeManager';
import { doneMoveMessage, TicketSourceFolderLive } from '~/Infrastructure/Tickets/TicketSource/folder';

import { WorktreeManagerInPlaceLive } from './inPlace';

// The in-place Worktree Manager, against a temporary Git repository whose queue is
// `.agents/tickets`, with the folder Source's done move in the same repository.

const project = Schema.decodeSync(Project)('auth');
const ticketId = formatTicketId('folder', '1');
const ticketsFolder = '.agents/tickets';
const ticketFile = '01-in-place.md';

const git = (cwd: string, args: readonly string[]) =>
  ChildProcessSpawner.ChildProcessSpawner.pipe(
    Effect.flatMap((spawner) => spawner.string(ChildProcess.make('git', args, { cwd }))),
    Effect.map((output) => output.trim())
  );

// A repository on the branch `trunk`, with a `package.json` and no `node_modules`.
// A tracked queue is part of the first commit; otherwise Git ignores it. An
// untracked queue is neither: it holds the ticket and Git does not ignore it.
const repositoryWith = (queue: 'tracked' | 'ignored' | 'untracked') =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.realPath(yield* fs.makeTempDirectory({ prefix: 'engine-in-place-' }));
    const tickets = path.join(root, ticketsFolder);
    yield* git(root, ['init', '-b', 'trunk']);
    yield* git(root, ['config', 'user.email', 'test@test.com']);
    yield* git(root, ['config', 'user.name', 'Test']);
    yield* fs.writeFileString(path.join(root, '.gitignore'), queue === 'ignored' ? `*.log\n${ticketsFolder}/\n` : '*.log\n');
    yield* fs.writeFileString(path.join(root, 'base.txt'), 'from trunk\n');
    yield* fs.writeFileString(path.join(root, 'package.json'), '{ "name": "in-place" }\n');
    yield* git(root, ['add', '-A']);
    if (queue === 'tracked') {
      yield* fs.makeDirectory(tickets, { recursive: true });
      yield* fs.writeFileString(path.join(tickets, ticketFile), '# 01 — In place\n\nStatus: ready-for-agent\n');
      yield* git(root, ['add', '-A']);
    }
    yield* git(root, ['commit', '-m', 'init']);
    if (queue !== 'tracked') {
      yield* fs.makeDirectory(tickets, { recursive: true });
      yield* fs.writeFileString(path.join(tickets, ticketFile), '# 01 — In place\n\nStatus: ready-for-agent\n');
    }
    return { root, tickets };
  });

const managerIn = (root: string, tickets?: string) =>
  WorktreeManager.pipe(Effect.provide(WorktreeManagerInPlaceLive(root, tickets)));

const isCleanIn = (root: string, tickets: string) =>
  managerIn(root, tickets).pipe(Effect.flatMap((manager) => manager.isClean({ path: root, branch: 'trunk' })));

const folderSourceIn = (root: string, tickets: string) =>
  TicketSourceFolderLive.pipe(
    Layer.provide(
      Layer.merge(
        ConfigProvider.layer(ConfigProvider.fromUnknown({ ticketsDir: tickets })),
        Layer.succeed(RepositoryRoot, root)
      )
    )
  );

// The done report of the folder Source in place, then what it leaves for after the
// merge, which the in-place merge never holds up.
const reportDoneIn = (root: string, tickets: string) =>
  Effect.gen(function* () {
    const manager = yield* managerIn(root, tickets);
    const worktree = yield* manager.prepareTicket({ id: ticketId });
    const source = yield* TicketSource;
    const afterMerge = yield* source.reportDone(ticketId, worktree);
    yield* manager.mergeAndClose(worktree);
    yield* afterMerge;
  }).pipe(Effect.provide(folderSourceIn(root, tickets)));

const run = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner>
) => Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)));

test('preparing a ticket, a Project ticket, or a Project returns the Repository Root on its current branch, with no dependency install', async () => {
  const result = await run(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, tickets } = yield* repositoryWith('tracked');
      const manager = yield* managerIn(root, tickets);
      return {
        root,
        ticket: yield* manager.prepareTicket({ id: ticketId }),
        projectTicket: yield* manager.prepareTicket({ id: ticketId, project }),
        project: yield* manager.prepareProject(project),
        installed: yield* fs.exists(path.join(root, 'node_modules')),
        worktrees: yield* git(root, ['worktree', 'list', '--porcelain']),
        branches: yield* git(root, ['branch', '--format=%(refname:short)']),
      };
    })
  );

  const atRoot = { path: result.root, branch: 'trunk' };
  expect(result.ticket).toEqual(atRoot);
  expect(result.projectTicket).toEqual(atRoot);
  expect(result.project).toEqual(atRoot);
  expect(result.installed).toBe(false);
  expect(result.worktrees.split('\n').filter((line) => line.startsWith('worktree '))).toEqual([`worktree ${result.root}`]);
  expect(result.branches).toBe('trunk');
});

test('preparing a ticket on a detached HEAD returns the Repository Root on HEAD', async () => {
  const prepared = await run(
    Effect.gen(function* () {
      const { root, tickets } = yield* repositoryWith('tracked');
      yield* git(root, ['checkout', '--detach']);
      const manager = yield* managerIn(root, tickets);
      return { root, worktree: yield* manager.prepareTicket({ id: ticketId }) };
    })
  );

  expect(prepared.worktree).toEqual({ path: prepared.root, branch: 'HEAD' });
});

test('merge and close changes nothing: no commit, no branch, and the tree as it was', async () => {
  const result = await run(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, tickets } = yield* repositoryWith('tracked');
      const manager = yield* managerIn(root, tickets);
      const worktree = yield* manager.prepareTicket({ id: ticketId });
      yield* fs.writeFileString(path.join(root, 'base.txt'), 'the work\n');
      yield* git(root, ['commit', '-am', 'feat: the work']);
      yield* fs.writeFileString(path.join(root, 'notes.txt'), 'left by hand\n');
      const before = {
        log: yield* git(root, ['log', '--format=%H %s']),
        branches: yield* git(root, ['branch', '--format=%(refname:short)']),
        status: yield* git(root, ['status', '--porcelain']),
      };
      yield* manager.mergeAndClose(worktree);
      const after = {
        log: yield* git(root, ['log', '--format=%H %s']),
        branches: yield* git(root, ['branch', '--format=%(refname:short)']),
        status: yield* git(root, ['status', '--porcelain']),
      };
      return { before, after, rootExists: yield* fs.exists(root) };
    })
  );

  expect(result.after).toEqual(result.before);
  expect(result.after.log.split('\n')).toHaveLength(2);
  expect(result.rootExists).toBe(true);
});

test('runCommand runs the command in the Repository Root', async () => {
  const result = await run(
    Effect.gen(function* () {
      const { root, tickets } = yield* repositoryWith('tracked');
      const manager = yield* managerIn(root, tickets);
      const worktree = yield* manager.prepareTicket({ id: ticketId });
      return { root, run: yield* manager.runCommand({ worktree, command: 'pwd && cat base.txt', timeLimit: '10 seconds' }) };
    })
  );

  expect(result.run).toEqual({ _tag: 'Exited', exitCode: 0, output: `${result.root}\nfrom trunk\n` });
});

test('isClean ignores untracked files under the tickets folder, at any depth', async () => {
  const clean = await run(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, tickets } = yield* repositoryWith('untracked');
      yield* fs.makeDirectory(path.join(tickets, 'auth', 'done'), { recursive: true });
      yield* fs.writeFileString(path.join(tickets, 'auth', 'done', '02-sign-in.md'), '# 02 — Sign in\n');
      return yield* isCleanIn(root, tickets);
    })
  );

  expect(clean).toBe(true);
});

test('isClean reports an untracked file outside the tickets folder, even in a folder whose name starts like it', async () => {
  const result = await run(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, tickets } = yield* repositoryWith('untracked');
      const beside = path.join(root, '.agents', 'tickets-old');
      yield* fs.makeDirectory(beside, { recursive: true });
      yield* fs.writeFileString(path.join(beside, 'stray.md'), 'stray\n');
      const besideQueue = yield* isCleanIn(root, tickets);
      yield* fs.remove(beside, { recursive: true });
      yield* fs.writeFileString(path.join(root, 'notes.txt'), 'left by hand\n');
      return { besideQueue, inRoot: yield* isCleanIn(root, tickets) };
    })
  );

  expect(result).toEqual({ besideQueue: false, inRoot: false });
});

test('isClean reports a change to a tracked file, under the tickets folder too', async () => {
  const result = await run(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, tickets } = yield* repositoryWith('tracked');
      const fresh = yield* isCleanIn(root, tickets);
      yield* fs.writeFileString(path.join(tickets, ticketFile), '# 01 — In place\n\n- [x] Ticked.\n');
      const ticketChanged = yield* isCleanIn(root, tickets);
      yield* git(root, ['checkout', '--', '.']);
      yield* git(root, ['mv', 'base.txt', 'moved.txt']);
      return { fresh, ticketChanged, renamed: yield* isCleanIn(root, tickets) };
    })
  );

  expect(result).toEqual({ fresh: true, ticketChanged: false, renamed: false });
});

test('isClean never counts an ignored file', async () => {
  const clean = await run(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, tickets } = yield* repositoryWith('ignored');
      yield* fs.writeFileString(path.join(root, 'run.log'), 'a log\n');
      return yield* isCleanIn(root, tickets);
    })
  );

  expect(clean).toBe(true);
});

test('isClean with no tickets folder counts every untracked file', async () => {
  const clean = await run(
    Effect.gen(function* () {
      const { root } = yield* repositoryWith('untracked');
      return yield* managerIn(root).pipe(Effect.flatMap((manager) => manager.isClean({ path: root, branch: 'trunk' })));
    })
  );

  expect(clean).toBe(false);
});

test('the done move of a tracked ticket is a commit on the current branch with the fixed message, and leaves the tree clean', async () => {
  const result = await run(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, tickets } = yield* repositoryWith('tracked');
      yield* reportDoneIn(root, tickets);
      return {
        branch: yield* git(root, ['branch', '--show-current']),
        subjects: yield* git(root, ['log', '--format=%s']),
        moved: yield* git(root, ['show', '--name-status', '--format=', 'HEAD']),
        open: yield* fs.exists(path.join(tickets, ticketFile)),
        done: yield* fs.exists(path.join(tickets, 'done', ticketFile)),
        clean: yield* isCleanIn(root, tickets),
      };
    })
  );

  expect(result.branch).toBe('trunk');
  expect(result.subjects.split('\n')).toEqual([doneMoveMessage(ticketId), 'init']);
  expect(result.moved).toBe(`R100\t${ticketsFolder}/${ticketFile}\t${ticketsFolder}/done/${ticketFile}`);
  expect(result.open).toBe(false);
  expect(result.done).toBe(true);
  expect(result.clean).toBe(true);
});

test.each(['ignored', 'untracked'] as const)(
  'the done move of a ticket that Git does not track (%s) moves the file with no commit',
  async (queue) => {
    const result = await run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { root, tickets } = yield* repositoryWith(queue);
        const head = yield* git(root, ['rev-parse', 'HEAD']);
        yield* reportDoneIn(root, tickets);
        return {
          headMoved: (yield* git(root, ['rev-parse', 'HEAD'])) !== head,
          open: yield* fs.exists(path.join(tickets, ticketFile)),
          done: yield* fs.exists(path.join(tickets, 'done', ticketFile)),
          clean: yield* isCleanIn(root, tickets),
        };
      })
    );

    expect(result).toEqual({ headMoved: false, open: false, done: true, clean: true });
  }
);
