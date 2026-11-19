import * as NodeServices from '@effect/platform-node/NodeServices';
import { Console, ConfigProvider, Effect, FileSystem, Layer, Path, Result, Schema } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { expect, test } from 'vitest';

import { EngineId } from '~/Core/Shared/Domain/Properties/EngineId';
import { RunnerId } from '~/Core/Shared/Domain/Properties/RunnerId';
import { RepositoryRoot } from '~/Core/Shared/Domain/RepositoryRoot';
import { HarnessSelector } from '~/Core/Shared/Ports/HarnessSelector';
import { processTicket } from '~/Core/Tickets/Application/UseCases/ProcessTicket/processTicket';
import { Claim } from '~/Core/Tickets/Domain/Entities/Claim/entity';
import { formatTicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';
import { EngineHalted } from '~/Core/Tickets/Domain/Exceptions/EngineHalted';
import { TicketEventNotReported } from '~/Core/Tickets/Domain/Exceptions/TicketEventNotReported';
import { WorktreeCloseError } from '~/Core/Tickets/Domain/Exceptions/WorktreeCloseError';
import { StrategySelector } from '~/Core/Tickets/Ports/StrategySelector';
import { TicketSource } from '~/Core/Tickets/Ports/TicketSource';
import { type Worktree, WorktreeManager } from '~/Core/Tickets/Ports/WorktreeManager';
import { makeLedgerMemory } from '~/Infrastructure/Tickets/Ledger/memory';

import { doneMoveMessage, TicketSourceFolderLive } from './folder';

// The done move of the folder Source, against a temporary Git repository. The
// test merges the ticket branch itself, as the Worktree Manager does, and runs
// what the Source returns for after the merge only when that merge succeeds.

const ticketId = formatTicketId('folder', '1');
const ticketFile = '1-done-move.md';
const ticketsFolder = '.agents/tickets';

// A ticket with front matter keys that Rippls does not know, and an open checkbox.
const ticketContent = [
  '---',
  'id: 1',
  'title: Done move',
  'kind: implementation',
  'status: ready-for-agent',
  'blockedBy: []',
  'blocks: []',
  'owner: someone-else',
  'estimate: 3',
  '---',
  '',
  '# Done move',
  '',
  '- [ ] Keep me.',
  '',
].join('\n');

const git = (cwd: string, args: readonly string[]) =>
  ChildProcessSpawner.ChildProcessSpawner.pipe(
    Effect.flatMap((spawner) => spawner.string(ChildProcess.make('git', args, { cwd }))),
    Effect.map((output) => output.trim())
  );

// A repository with the ticket in its tickets folder. A committed ticket is part
// of the first commit; otherwise Git ignores the tickets folder.
const repositoryWith = ({ committed, file = ticketFile }: { readonly committed: boolean; readonly file?: string }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectory({ prefix: 'engine-done-move-' });
    const tickets = path.join(root, ticketsFolder);
    yield* git(root, ['init', '-b', 'main']);
    yield* git(root, ['config', 'user.email', 'test@test.com']);
    yield* git(root, ['config', 'user.name', 'Test']);
    yield* fs.makeDirectory(path.dirname(path.join(tickets, file)), { recursive: true });
    yield* fs.writeFileString(path.join(tickets, file), ticketContent);
    yield* fs.writeFileString(path.join(root, '.gitignore'), committed ? '.sandcastle/\n' : `.sandcastle/\n${ticketsFolder}/\n`);
    yield* fs.writeFileString(path.join(root, 'base.txt'), 'from main\n');
    yield* git(root, ['add', '-A']);
    yield* git(root, ['commit', '-m', 'init']);
    return { root, tickets };
  });

// A Ticket Worktree on its ticket branch, with one commit of work on it.
const ticketWorktreeIn = (root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const worktree: Worktree = { path: path.join(root, '.sandcastle', 'worktrees', 'ticket-folder-1'), branch: 'ticket-folder-1' };
    yield* git(root, ['worktree', 'add', '-b', worktree.branch, worktree.path, 'HEAD']);
    yield* fs.writeFileString(path.join(worktree.path, 'work.txt'), 'the work\n');
    yield* git(worktree.path, ['add', 'work.txt']);
    yield* git(worktree.path, ['commit', '-m', 'feat: the work']);
    return worktree;
  });

const folderSourceIn = (root: string, tickets: string) =>
  TicketSourceFolderLive.pipe(
    Layer.provide(
      Layer.merge(
        ConfigProvider.layer(ConfigProvider.fromUnknown({ ticketsDir: tickets })),
        Layer.succeed(RepositoryRoot, root)
      )
    )
  );

const reportDoneIn = (root: string, tickets: string, worktree: Worktree, ticket = ticketId) =>
  TicketSource.pipe(
    Effect.flatMap((source) => source.reportDone(ticket, worktree)),
    Effect.provide(folderSourceIn(root, tickets))
  );

const run = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner>
) => Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)));

test('a committed ticket moves into done/ in a commit on the ticket branch, and the merge lands the move', async () => {
  const result = await run(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, tickets } = yield* repositoryWith({ committed: true });
      const worktree = yield* ticketWorktreeIn(root);
      const afterMerge = yield* reportDoneIn(root, tickets, worktree);
      const rootBeforeMerge = yield* git(root, ['status', '--porcelain']);
      const inPlaceBeforeMerge = yield* fs.exists(path.join(tickets, ticketFile));
      const branchHead = yield* git(worktree.path, ['log', '-1', '--format=%s']);
      const branchMove = yield* git(worktree.path, ['show', '--name-status', '--format=', 'HEAD']);
      const worktreeStatus = yield* git(worktree.path, ['status', '--porcelain']);
      yield* git(root, ['merge', '--no-ff', '--no-edit', worktree.branch]);
      yield* afterMerge;
      return {
        rootBeforeMerge,
        inPlaceBeforeMerge,
        branchHead,
        branchMove,
        worktreeStatus,
        merged: yield* fs.readFileString(path.join(tickets, 'done', ticketFile)),
        stillOpen: yield* fs.exists(path.join(tickets, ticketFile)),
        rootAfterMerge: yield* git(root, ['status', '--porcelain']),
      };
    })
  );

  expect(result.rootBeforeMerge).toBe('');
  expect(result.inPlaceBeforeMerge).toBe(true);
  expect(result.branchHead).toBe(doneMoveMessage(ticketId));
  expect(result.branchMove).toBe(`R100\t${ticketsFolder}/${ticketFile}\t${ticketsFolder}/done/${ticketFile}`);
  expect(result.worktreeStatus).toBe('');
  expect(result.merged).toBe(ticketContent);
  expect(result.stillOpen).toBe(false);
  expect(result.rootAfterMerge).toBe('');
});

test('a committed ticket of a feature folder moves into the done/ of its own folder on the ticket branch', async () => {
  const featureTicket = formatTicketId('folder', 'auth/1');
  const result = await run(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, tickets } = yield* repositoryWith({ committed: true, file: `auth/${ticketFile}` });
      const worktree = yield* ticketWorktreeIn(root);
      const afterMerge = yield* reportDoneIn(root, tickets, worktree, featureTicket);
      const branchHead = yield* git(worktree.path, ['log', '-1', '--format=%s']);
      const branchMove = yield* git(worktree.path, ['show', '--name-status', '--format=', 'HEAD']);
      yield* git(root, ['merge', '--no-ff', '--no-edit', worktree.branch]);
      yield* afterMerge;
      return {
        branchHead,
        branchMove,
        merged: yield* fs.readFileString(path.join(tickets, 'auth', 'done', ticketFile)),
        rootDone: yield* fs.exists(path.join(tickets, 'done')),
        rootAfterMerge: yield* git(root, ['status', '--porcelain']),
      };
    })
  );

  expect(result.branchHead).toBe(doneMoveMessage(featureTicket));
  expect(result.branchMove).toBe(`R100\t${ticketsFolder}/auth/${ticketFile}\t${ticketsFolder}/auth/done/${ticketFile}`);
  expect(result.merged).toBe(ticketContent);
  expect(result.rootDone).toBe(false);
  expect(result.rootAfterMerge).toBe('');
});

test('a ticket that is not in the Ticket Worktree moves into done/ only after a successful merge', async () => {
  const result = await run(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, tickets } = yield* repositoryWith({ committed: false });
      const worktree = yield* ticketWorktreeIn(root);
      const afterMerge = yield* reportDoneIn(root, tickets, worktree);
      const inPlaceBeforeMerge = yield* fs.exists(path.join(tickets, ticketFile));
      const branchHead = yield* git(worktree.path, ['log', '-1', '--format=%s']);
      yield* git(root, ['merge', '--no-ff', '--no-edit', worktree.branch]);
      yield* afterMerge;
      return {
        inPlaceBeforeMerge,
        branchHead,
        moved: yield* fs.readFileString(path.join(tickets, 'done', ticketFile)),
        stillOpen: yield* fs.exists(path.join(tickets, ticketFile)),
        rootAfterMerge: yield* git(root, ['status', '--porcelain']),
      };
    })
  );

  expect(result.inPlaceBeforeMerge).toBe(true);
  expect(result.branchHead).toBe('feat: the work');
  expect(result.moved).toBe(ticketContent);
  expect(result.stillOpen).toBe(false);
  expect(result.rootAfterMerge).toBe('');
});

test('a ticket already in done/ is not moved again', async () => {
  const result = await run(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, tickets } = yield* repositoryWith({ committed: true });
      const worktree = yield* ticketWorktreeIn(root);
      // The Agent moved its own ticket into done/ on the ticket branch.
      yield* fs.makeDirectory(path.join(worktree.path, ticketsFolder, 'done'), { recursive: true });
      yield* git(worktree.path, ['mv', `${ticketsFolder}/${ticketFile}`, `${ticketsFolder}/done/${ticketFile}`]);
      yield* git(worktree.path, ['commit', '-m', 'chore: tick the ticket']);
      const afterMerge = yield* reportDoneIn(root, tickets, worktree);
      const branchHead = yield* git(worktree.path, ['log', '-1', '--format=%s']);
      yield* git(root, ['merge', '--no-ff', '--no-edit', worktree.branch]);
      yield* afterMerge;
      return {
        branchHead,
        merged: yield* fs.readFileString(path.join(tickets, 'done', ticketFile)),
        rootAfterMerge: yield* git(root, ['status', '--porcelain']),
      };
    })
  );

  expect(result.branchHead).toBe('chore: tick the ticket');
  expect(result.merged).toBe(ticketContent);
  expect(result.rootAfterMerge).toBe('');
});

test('a commit hook that rejects the move fails the done report and leaves the Ticket Worktree as it was', async () => {
  const result = await run(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, tickets } = yield* repositoryWith({ committed: true });
      const worktree = yield* ticketWorktreeIn(root);
      const hooks = path.join(root, '.git', 'hooks');
      yield* fs.writeFileString(path.join(hooks, 'pre-commit'), '#!/bin/sh\nexit 1\n');
      yield* fs.chmod(path.join(hooks, 'pre-commit'), 0o755);
      const report = yield* reportDoneIn(root, tickets, worktree).pipe(Effect.result);
      return {
        report,
        branchHead: yield* git(worktree.path, ['log', '-1', '--format=%s']),
        worktreeStatus: yield* git(worktree.path, ['status', '--porcelain']),
      };
    })
  );

  expect(result.report).toEqual(Result.fail(new TicketEventNotReported({ ticketId, event: 'done' })));
  expect(result.branchHead).toBe('feat: the work');
  expect(result.worktreeStatus).toBe('');
});

// Ticket Processing of the ticket with the folder Source, a Strategy that
// succeeds, and a Worktree Manager that merges the ticket branch into the
// Repository Root with Git. The Engine holds the Claim on the ticket.
const engine = Schema.decodeSync(EngineId)('standalone');
const runnerId = Schema.decodeSync(RunnerId)('standalone:0');

const gitWorktrees = (root: string, worktree: Worktree) =>
  Layer.effect(
    WorktreeManager,
    ChildProcessSpawner.ChildProcessSpawner.pipe(
      Effect.map((spawner) => {
        const exitOf = (args: readonly string[]) => spawner.exitCode(ChildProcess.make('git', args, { cwd: root }));
        return {
          prepareProject: () => Effect.die('prepareProject should not be called'),
          prepareTicket: () => Effect.succeed(worktree),
          runCommand: () => Effect.die('runCommand should not be called'),
          isClean: () => Effect.succeed(true),
          mergeAndClose: () =>
            exitOf(['merge', '--no-ff', '--no-edit', worktree.branch]).pipe(
              Effect.orDie,
              Effect.flatMap((code) =>
                code === 0
                  ? Effect.void
                  : exitOf(['merge', '--abort']).pipe(Effect.orDie, Effect.andThen(Effect.fail(new WorktreeCloseError())))
              )
            ),
        };
      })
    )
  );

const processIn = (root: string, tickets: string, worktree: Worktree) =>
  Effect.gen(function* () {
    const ledger = makeLedgerMemory();
    ledger.claims.set(ticketId, new Claim({ ticket: ticketId, engine, process: 1, host: 'memory' }));
    const services = Layer.mergeAll(
      folderSourceIn(root, tickets),
      ledger.layer,
      gitWorktrees(root, worktree),
      Layer.succeed(HarnessSelector, {
        select: Effect.succeed({ name: 'test', model: 'test-model', run: () => Effect.succeed({ completionSignal: undefined }) }),
      }),
      Layer.succeed(StrategySelector, {
        select: () => Effect.succeed({ name: 'implementation', run: () => Effect.succeed(Result.succeed(undefined)) }),
      })
    );
    const processed = yield* Effect.gen(function* () {
      const source = yield* TicketSource;
      const ticket = yield* source.getOneBy({ id: ticketId });
      return yield* processTicket({ ticket, runnerId, repositoryRoot: root });
    }).pipe(
      Effect.provide(services),
      Effect.provideService(Console.Console, Object.assign(Object.create(console), { log: () => {}, error: () => {} })),
      Effect.result
    );
    return { processed, ledger };
  });

test('Ticket Processing keeps the front matter keys that Rippls does not know, and lands the ticket in done/ with the work', async () => {
  const result = await run(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, tickets } = yield* repositoryWith({ committed: true });
      const worktree = yield* ticketWorktreeIn(root);
      const { processed, ledger } = yield* processIn(root, tickets, worktree);
      return {
        processed,
        done: [...ledger.done],
        claims: [...ledger.claims.keys()],
        merged: yield* fs.readFileString(path.join(tickets, 'done', ticketFile)),
        work: yield* fs.readFileString(path.join(root, 'work.txt')),
        rootStatus: yield* git(root, ['status', '--porcelain']),
      };
    })
  );

  expect(result.processed).toEqual(Result.succeed(undefined));
  expect(result.merged).toBe(ticketContent);
  expect(result.work).toBe('the work\n');
  expect(result.rootStatus).toBe('');
  expect(result.done).toEqual([ticketId]);
  expect(result.claims).toEqual([]);
});

test('Ticket Processing moves a ticket that is not in the Ticket Worktree into done/ after a successful merge', async () => {
  const result = await run(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, tickets } = yield* repositoryWith({ committed: false });
      const worktree = yield* ticketWorktreeIn(root);
      const { processed, ledger } = yield* processIn(root, tickets, worktree);
      return {
        processed,
        done: [...ledger.done],
        moved: yield* fs.readFileString(path.join(tickets, 'done', ticketFile)),
        stillOpen: yield* fs.exists(path.join(tickets, ticketFile)),
      };
    })
  );

  expect(result.processed).toEqual(Result.succeed(undefined));
  expect(result.moved).toBe(ticketContent);
  expect(result.stillOpen).toBe(false);
  expect(result.done).toEqual([ticketId]);
});

test('Ticket Processing leaves a ticket that is not in the Ticket Worktree in place after a failed merge, with no done in the Ledger', async () => {
  const result = await run(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, tickets } = yield* repositoryWith({ committed: false });
      const worktree = yield* ticketWorktreeIn(root);
      // A change on main to the file the work changed makes the merge conflict.
      yield* fs.writeFileString(path.join(root, 'work.txt'), 'other work\n');
      yield* git(root, ['add', 'work.txt']);
      yield* git(root, ['commit', '-m', 'feat: other work']);
      const { processed, ledger } = yield* processIn(root, tickets, worktree);
      return {
        processed,
        done: [...ledger.done],
        content: yield* fs.readFileString(path.join(tickets, ticketFile)),
        inDone: yield* fs.exists(path.join(tickets, 'done', ticketFile)),
      };
    })
  );

  expect(result.processed).toEqual(Result.fail(new EngineHalted({ ticketId, reason: 'worktree close failure' })));
  expect(result.content).toBe(ticketContent);
  expect(result.inDone).toBe(false);
  expect(result.done).toEqual([]);
});
