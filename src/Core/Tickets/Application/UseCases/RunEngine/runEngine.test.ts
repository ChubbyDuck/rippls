import * as NodeServices from '@effect/platform-node/NodeServices';
import { ConfigProvider, Console, Deferred, Duration, Effect, FileSystem, Fiber, Layer, Path, type PlatformError, Random, Result, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { expect, test } from 'vitest';

import {
  type CheckConfig,
  type CommitConfig,
  defaultCheckConfig,
  defaultCommitConfig,
  defaultCommitPrompt,
  defaultFixPrompt,
} from '~/Core/Shared/Domain/EngineConfig';
import { HarnessRuntimeError } from '~/Core/Shared/Domain/Exceptions/HarnessRuntimeError';
import { EngineId } from '~/Core/Shared/Domain/Properties/EngineId';
import { runnerIdFrom } from '~/Core/Shared/Domain/Properties/RunnerId';
import { RepositoryRoot } from '~/Core/Shared/Domain/RepositoryRoot';
import type { Harness, ModelDemand } from '~/Core/Shared/Ports/Harness';
import { HarnessSelector } from '~/Core/Shared/Ports/HarnessSelector';
import { Claim } from '~/Core/Tickets/Domain/Entities/Claim/entity';
import { Escalation } from '~/Core/Tickets/Domain/Entities/Escalation/entity';
import { Ticket } from '~/Core/Tickets/Domain/Entities/Ticket/entity';
import { formatTicketId, type TicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';
import { UnreadableTicket } from '~/Core/Tickets/Domain/Entities/UnreadableTicket/entity';
import { Project } from '~/Core/Tickets/Domain/Entities/Ticket/properties/Project';
import type { TicketEvent } from '~/Core/Tickets/Domain/Events/TicketEvent';
import { ConcurrencyNotInPlace } from '~/Core/Tickets/Domain/Exceptions/ConcurrencyNotInPlace';
import { EngineHalted } from '~/Core/Tickets/Domain/Exceptions/EngineHalted';
import { RepositoryRootDirty } from '~/Core/Tickets/Domain/Exceptions/RepositoryRootDirty';
import { RepositoryRootNotFound } from '~/Core/Tickets/Domain/Exceptions/RepositoryRootNotFound';
import { StrategyRuntimeError } from '~/Core/Tickets/Domain/Exceptions/StrategyRuntimeError';
import { TicketEventNotReported } from '~/Core/Tickets/Domain/Exceptions/TicketEventNotReported';
import { TicketNotFound } from '~/Core/Tickets/Domain/Exceptions/TicketNotFound';
import { matchesQuery, type TicketQuery } from '~/Core/Tickets/Domain/Queries/TicketQuery';
import { renderPrompt } from '~/Core/Tickets/Domain/Services/promptTemplate';
import { WorktreeCloseError } from '~/Core/Tickets/Domain/Exceptions/WorktreeCloseError';
import { WorktreeCommandError } from '~/Core/Tickets/Domain/Exceptions/WorktreeCommandError';
import { Ledger } from '~/Core/Tickets/Ports/Ledger';
import { StrategySelector } from '~/Core/Tickets/Ports/StrategySelector';
import { type AfterMerge, TicketSource } from '~/Core/Tickets/Ports/TicketSource';
import { type CommandRun, type Worktree, WorktreeManager } from '~/Core/Tickets/Ports/WorktreeManager';
import { makeLedgerMemory } from '~/Infrastructure/Tickets/Ledger/memory';
import { StrategySelectorNoop } from '~/Infrastructure/Tickets/StrategySelector/noop';
import { doneMoveMessage, TicketSourceFolderLive } from '~/Infrastructure/Tickets/TicketSource/folder';
import { WorktreeManagerInPlaceLive } from '~/Infrastructure/Tickets/WorktreeManager/inPlace';
import { WorktreeManagerLive } from '~/Infrastructure/Tickets/WorktreeManager/sandcastle';

import { retryTicket } from '../RetryTicket/retryTicket';

import type { RunEngineCommand } from './command';
import { createEngine } from './createEngine';
import { runEngine as executeEngine } from './runEngine';

// As the real Worktree Manager does, the fake names the branch of a Ticket Worktree
// from the ticket identity with the characters unsafe in a branch name replaced.
const ticketWorktreeOf = (ticket: TicketId) => {
  const branch = `ticket-${ticket.replace(/[^A-Za-z0-9_-]/g, '-')}`;
  return { path: `/repo/.sandcastle/worktrees/${branch}`, branch };
};

const WorktreeManagerNoop = Layer.succeed(WorktreeManager, {
  prepareProject: (project) => Effect.succeed({ path: `/repo/.sandcastle/worktrees/${project}`, branch: project }),
  prepareTicket: ({ id }) => Effect.succeed(ticketWorktreeOf(id)),
  runCommand: () => Effect.die('runCommand should not be called'),
  changedPaths: () => Effect.succeed([]),
  mergeAndClose: () => Effect.void,
});

const EngineStartupTest = Layer.mergeAll(
  Path.layer,
  FileSystem.layerNoop({
    exists: () => Effect.succeed(true),
    access: () => Effect.void,
  }),
  Layer.succeed(RepositoryRoot, '/repo'),
  WorktreeManagerNoop
);

const runEngine = (command: RunEngineCommand = {}, ledger = makeLedgerMemory()) =>
  executeEngine(command).pipe(Random.withSeed('test'), Effect.provide(Layer.merge(EngineStartupTest, ledger.layer)));
const engineId = Effect.runSync(createEngine.pipe(Random.withSeed('test'))).id;

const project = Schema.decodeSync(Project)('0003-sandboxed-local-ticket-loop.md');
const id = (value: number) => formatTicketId('folder', String(value));

// A fake Source that keeps tickets in memory, in the order they were added. A read
// for the tickets in scope returns every one of them, narrowed only by Project:
// the Engine, not the Source, decides which ticket is Eligible. The other reads
// (by identity and blocked-by) answer as the real Sources do. Every reported
// event is recorded, and every ticket reported done. A done report changes
// nothing in the store, as for a Project ticket whose move has not reached the
// Repository Root: the Ledger alone makes the ticket done.
type Reported = { readonly ticket: TicketId; readonly event: TicketEvent };

const fakeSource = (
  seed: readonly Ticket[] = [],
  options: {
    readonly report?: (
      ticket: TicketId,
      event: TicketEvent
    ) => Effect.Effect<void, TicketEventNotReported>;
    readonly reportDone?: (ticket: TicketId, worktree: Worktree) => Effect.Effect<AfterMerge, TicketEventNotReported>;
    readonly unreadable?: readonly UnreadableTicket[];
  } = {}
) => {
  const store = new Map(seed.map((ticket) => [ticket.id, ticket]));
  const scopeReads: TicketQuery[] = [];
  const reports: Reported[] = [];
  const doneReported: TicketId[] = [];
  const read = (query: TicketQuery) => Array.from(store.values()).filter(matchesQuery(query));
  const isScopeRead = (query: TicketQuery) => query.id === undefined;
  const layer = Layer.succeed(TicketSource, {
    getOneBy: (query) =>
      Effect.suspend(() => {
        const [found] = read(query);
        return found === undefined ? Effect.fail(new TicketNotFound()) : Effect.succeed(found);
      }),
    getManyBy: (query) =>
      Effect.sync(() => {
        if (isScopeRead(query)) {
          scopeReads.push(query);
        }
        return read(query);
      }),
    getUnreadable: Effect.succeed(options.unreadable ?? []),
    report: (ticket, event) =>
      (options.report ?? (() => Effect.void))(ticket, event).pipe(
        Effect.andThen(
          Effect.sync(() => {
            reports.push({ ticket, event });
          })
        )
      ),
    reportDone: (ticket, worktree) =>
      (options.reportDone ?? (() => Effect.succeed(Effect.void)))(ticket, worktree).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            doneReported.push(ticket);
          })
        )
      ),
  });
  const add = (ticket: Ticket) => {
    store.set(ticket.id, ticket);
  };
  return { layer, store, scopeReads, reports, doneReported, add };
};

// The Engine reads the tickets in scope once at start, to report what it cannot
// read, before its first poll.
const startRead = 1;

// A Claim that another Engine holds in the shared Ledger.
const otherEngine = Schema.decodeSync(EngineId)('other-engine-0000');
const heldByOther = (ticket: TicketId) =>
  Claim.make({ ticket, engine: otherEngine, process: 1, host: 'memory' });

const sampleFields = (value = 1) => ({
  id: id(value),
  title: 'Random ticket',
  project,
  kind: 'implementation',
  hitl: 'no',
  blockedBy: [],
  body: '',
});

const sampleTicket = (value = 1) => Ticket.create(sampleFields(value));

// The ticket as its Source sees it once it is done.
const seenAsDone = (ticket: Ticket) =>
  Ticket.make({
    id: ticket.id,
    title: ticket.title,
    project: ticket.project,
    kind: ticket.kind,
    hitl: ticket.hitl,
    blockedBy: ticket.blockedBy,
    body: ticket.body,
    doneInSource: true,
    claimedInSource: false,
  });

const blockedTicket = (value: number, blockedBy: number) =>
  Ticket.create({
    id: id(value),
    title: 'Blocked ticket',
    project,
    kind: 'implementation',
    hitl: 'no',
    blockedBy: [id(blockedBy)],
    body: '',
  });

const until = (isReady: () => boolean) =>
  Effect.gen(function* () {
    while (!isReady()) {
      yield* Effect.yieldNow;
    }
  });

const runUntil = <A, E>(effect: Effect.Effect<A, E>, isReady: () => boolean) =>
  Effect.runPromise(effect.pipe(Effect.race(until(isReady))));

const capturingConsole = (messages: string[]): Console.Console =>
  Object.assign(Object.create(console), {
    log: (...args: ReadonlyArray<unknown>) => {
      messages.push(args.map(String).join(' '));
    },
    warn: (...args: ReadonlyArray<unknown>) => {
      messages.push(args.map(String).join(' '));
    },
    error: (...args: ReadonlyArray<unknown>) => {
      messages.push(args.map(String).join(' '));
    },
  });

const gitRootOf = (root: string) => Layer.succeed(RepositoryRoot, root);

const HarnessSelectorNoop = Layer.succeed(HarnessSelector, {
  select: Effect.succeed({
    name: 'default',
    model: 'default-model',
    run: () => Effect.succeed({ completionSignal: undefined }),
  } satisfies Harness),
});

const claiming = runnerIdFrom(engineId, '0');

const capturingImplementation = (ran: Ticket[]) =>
  Layer.succeed(StrategySelector, {
    select: (kind) =>
      Effect.succeed({
        name: kind,
        run: (ticket) =>
          kind === 'implementation'
            ? Effect.sync(() => {
                ran.push(ticket);
                return Result.succeed(undefined);
              })
            : Effect.succeed(Result.succeed(undefined)),
      }),
  });

// A strategy that records the Claim the Ledger holds on each ticket while a Runner
// processes it.
const claimRecordingImplementation = (
  ledger: ReturnType<typeof makeLedgerMemory>,
  seen: Array<Claim | undefined>,
  run: Effect.Effect<void> = Effect.void
) =>
  Layer.succeed(StrategySelector, {
    select: (kind) =>
      Effect.succeed({
        name: kind,
        run: (ticket) =>
          Effect.sync(() => {
            seen.push(ledger.claims.get(ticket.id));
          }).pipe(Effect.andThen(run), Effect.as(Result.succeed(undefined))),
      }),
  });

test('runEngine runs each ready ticket and keeps polling when none remain', async () => {
  const first = sampleTicket(1);
  const second = sampleTicket(2);
  const ran: Ticket[] = [];
  const layer = Layer.mergeAll(
    fakeSource([first, second]).layer,
    HarnessSelectorNoop,
    capturingImplementation(ran)
  );

  expect(await runUntil(runEngine({ project }).pipe(Effect.provide(layer)), () => ran.length === 2)).toBeUndefined();
  expect(ran).toEqual([first, second]);
});

test('runEngine in a Watch runs tickets that appear after an empty poll', async () => {
  const first = sampleTicket(1);
  const second = sampleTicket(2);
  const ran: Ticket[] = [];
  const source = fakeSource([first]);
  const layer = Layer.mergeAll(source.layer, HarnessSelectorNoop, capturingImplementation(ran));

  await Effect.runPromise(
    Effect.gen(function* () {
      yield* runEngine({ project, watch: true }).pipe(Effect.forkChild({ startImmediately: true }));
      expect(ran).toEqual([first]);
      source.add(second);
      yield* TestClock.adjust('10 seconds');
      expect(ran).toEqual([first, second]);
    }).pipe(Effect.provide(Layer.mergeAll(layer, TestClock.layer())))
  );
});

test('runEngine claims each ticket and reports the Claim before a Runner takes it', async () => {
  const messages: string[] = [];
  const source = fakeSource([sampleTicket(1), sampleTicket(2)]);
  const layer = Layer.mergeAll(
    source.layer,
    HarnessSelectorNoop,
    StrategySelectorNoop,
    Layer.succeed(Console.Console, capturingConsole(messages))
  );

  expect(
    await runUntil(runEngine({ project, watch: true }).pipe(Effect.provide(layer)), () => source.doneReported.length === 2)
  ).toBeUndefined();
  expect(source.doneReported).toEqual([id(1), id(2)]);
  expect(source.reports).toEqual([
    { ticket: id(1), event: 'claimed' },
    { ticket: id(2), event: 'claimed' },
  ]);
  expect(messages.filter((message) => message !== 'No tickets are found, continuing')).toEqual([
    'Ticket folder:1 -- implementation is claimed',
    `Ticket folder:1 -- implementation is taken into the runner ${claiming}`,
    "Ticket folder:1 -- implementation is processed by 'implementation' strategy and 'default' harness using 'default-model'",
    'Ticket folder:1 -- implementation works in its Workspace on branch ticket-folder-1 at /repo/.sandcastle/worktrees/ticket-folder-1',
    '',
    'Ticket folder:1 -- implementation has no check command configured, so the check is skipped',
    'Ticket folder:1 -- implementation has its work committed on branch ticket-folder-1',
    'Ticket folder:1 -- implementation is done',
    'Ticket folder:2 -- implementation is claimed',
    `Ticket folder:2 -- implementation is taken into the runner ${claiming}`,
    "Ticket folder:2 -- implementation is processed by 'implementation' strategy and 'default' harness using 'default-model'",
    'Ticket folder:2 -- implementation works in its Workspace on branch ticket-folder-2 at /repo/.sandcastle/worktrees/ticket-folder-2',
    '',
    'Ticket folder:2 -- implementation has no check command configured, so the check is skipped',
    'Ticket folder:2 -- implementation has its work committed on branch ticket-folder-2',
    'Ticket folder:2 -- implementation is done',
  ]);
});

test('runEngine claims a ticket in the Ledger before a Runner processes it, and releases it once done', async () => {
  const ledger = makeLedgerMemory();
  const seen: Array<Claim | undefined> = [];
  const source = fakeSource([sampleTicket(1)]);
  const layer = Layer.mergeAll(source.layer, HarnessSelectorNoop, claimRecordingImplementation(ledger, seen));

  expect(await Effect.runPromise(runEngine({ project, limit: 1 }, ledger).pipe(Effect.provide(layer)))).toBeUndefined();
  expect(seen).toEqual([Claim.make({ ticket: id(1), engine: engineId, process: 1, host: 'memory', runner: claiming })]);
  expect(source.doneReported).toEqual([id(1)]);
  expect([...ledger.done]).toEqual([id(1)]);
  expect(ledger.claims.size).toBe(0);
});

test('runEngine in a Watch narrates taking tickets and continuing after an empty poll', async () => {
  const messages: string[] = [];
  const layer = Layer.mergeAll(
    fakeSource([sampleTicket(1), sampleTicket(2)]).layer,
    HarnessSelectorNoop,
    StrategySelectorNoop,
    Layer.succeed(Console.Console, capturingConsole(messages))
  );

  expect(
    await runUntil(runEngine({ project, watch: true }).pipe(Effect.provide(layer)), () =>
      messages.includes('No tickets are found, continuing')
    )
  ).toBeUndefined();
  expect(
    messages.filter(
      (message) => message.includes('is taken into the runner') || message === 'No tickets are found, continuing'
    )
  ).toEqual([
    `Ticket folder:1 -- implementation is taken into the runner ${claiming}`,
    `Ticket folder:2 -- implementation is taken into the runner ${claiming}`,
    'No tickets are found, continuing',
  ]);
});

test('runEngine reads every ticket in the provided project', async () => {
  const source = fakeSource([sampleTicket()]);
  const layer = Layer.mergeAll(source.layer, HarnessSelectorNoop, StrategySelectorNoop);

  expect(
    await runUntil(runEngine({ project }).pipe(Effect.provide(layer)), () => source.scopeReads.length > 0)
  ).toBeUndefined();
  expect(source.scopeReads[0]).toEqual({ project });
});

test('runEngine does not scope the read when project is omitted', async () => {
  const source = fakeSource([sampleTicket()]);
  const layer = Layer.mergeAll(source.layer, HarnessSelectorNoop, StrategySelectorNoop);

  expect(await runUntil(runEngine().pipe(Effect.provide(layer)), () => source.scopeReads.length > 0)).toBeUndefined();
  expect(source.scopeReads[0]).toEqual({});
});

test('runEngine takes only Eligible tickets, in the order of the Source', async () => {
  const ran: Ticket[] = [];
  const ledger = makeLedgerMemory();
  const attended = Ticket.create({
    id: id(3),
    title: 'Attended ticket',
    project,
    kind: 'task',
    hitl: 'yes',
    blockedBy: [],
    body: '',
  });
  const source = fakeSource([
    sampleTicket(6),
    blockedTicket(1, 99),
    sampleTicket(2),
    attended,
    sampleTicket(4),
    sampleTicket(5),
  ]);
  ledger.claims.set(id(2), heldByOther(id(2)));
  ledger.claims.set(id(4), heldByOther(id(4)));
  const layer = Layer.mergeAll(source.layer, HarnessSelectorNoop, capturingImplementation(ran));

  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* runEngine({ project }, ledger).pipe(
        Effect.provide(layer),
        Effect.forkChild({ startImmediately: true })
      );
      yield* TestClock.adjust('0 millis');
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(TestClock.layer()))
  );

  expect(ran.map((ticket) => ticket.id)).toEqual([id(6), id(5)]);
});

test('runEngine takes a ticket whose claim field an earlier Engine wrote, since the Ledger holds no Claim on it', async () => {
  const ran: Ticket[] = [];
  // An earlier Engine wrote its Claim into the ticket. The Ledger holds no Claim
  // on it, so the ticket is Unclaimed.
  const source = fakeSource([]);
  const layer = Layer.mergeAll(source.layer, HarnessSelectorNoop, capturingImplementation(ran));
  source.add(Ticket.create({ ...sampleFields(1), claimedBy: 'old-runner' }));

  expect(await Effect.runPromise(runEngine({ project, limit: 1 }).pipe(Effect.provide(layer)))).toBeUndefined();
  expect(ran.map((ticket) => ticket.id)).toEqual([id(1)]);
});

test('runEngine takes the chosen ticket as the Source reads it by identity', async () => {
  const ran: Ticket[] = [];
  const fields = {
    id: id(1),
    title: 'Full ticket',
    project,
    kind: 'implementation',
    blockedBy: [],
  };
  const full = Ticket.create({ ...fields, body: 'The whole body.' });
  const head = Ticket.create({ ...fields, body: '' });
  const source = fakeSource([full]);
  const headOnly = Layer.succeed(TicketSource, {
    ...Effect.runSync(TicketSource.pipe(Effect.provide(source.layer))),
    getManyBy: (query) =>
      query.id === undefined
        ? Effect.succeed([head])
        : Effect.succeed([]),
  });
  const layer = Layer.mergeAll(headOnly, HarnessSelectorNoop, capturingImplementation(ran));

  expect(await Effect.runPromise(runEngine({ project, limit: 1 }).pipe(Effect.provide(layer)))).toBeUndefined();
  expect(ran).toEqual([full]);
});

test('runEngine takes the next Eligible ticket when the chosen one is no longer Eligible by identity', async () => {
  const ran: Ticket[] = [];
  const ledger = makeLedgerMemory();
  const attended = Ticket.create({ ...sampleFields(1), kind: 'task', hitl: 'yes' });
  const source = fakeSource([attended, sampleTicket(2)]);
  const staleList = Layer.succeed(TicketSource, {
    ...Effect.runSync(TicketSource.pipe(Effect.provide(source.layer))),
    getManyBy: (query) =>
      query.id === undefined
        ? Effect.succeed([sampleTicket(1), sampleTicket(2)])
        : Effect.succeed([]),
  });
  const layer = Layer.mergeAll(staleList, HarnessSelectorNoop, capturingImplementation(ran));

  expect(await Effect.runPromise(runEngine({ project, limit: 1 }, ledger).pipe(Effect.provide(layer)))).toBeUndefined();
  expect(ran).toEqual([sampleTicket(2)]);
  expect(source.reports).toEqual([{ ticket: id(2), event: 'claimed' }]);
});

test('runEngine takes a blocked ticket once its blocker is done in the Ledger, without writing to it before', async () => {
  const ran: Ticket[] = [];
  // Ticket 1 comes first in the order of the Source, so it would be taken first if
  // it were Eligible while ticket 2 is open.
  const dependent = Ticket.create({
    id: id(1),
    title: 'Dependent ticket',
    project,
    kind: 'implementation',
    blockedBy: [id(2)],
    body: '',
  });
  const blocker = sampleTicket(2);
  const source = fakeSource([dependent, blocker]);
  const layer = Layer.mergeAll(source.layer, HarnessSelectorNoop, capturingImplementation(ran));

  expect(await Effect.runPromise(runEngine({ project, limit: 2 }).pipe(Effect.provide(layer)))).toBeUndefined();
  expect(ran).toEqual([blocker, dependent]);
  expect(source.doneReported).toEqual([id(2), id(1)]);
  expect(source.store.get(id(1))).toEqual(dependent);
});

test('runEngine in a Watch does not take a ticket while its blocker is not done, and takes it once the blocker is done', async () => {
  const ran: Ticket[] = [];
  const attendedBlocker = Ticket.create({
    id: id(2),
    title: 'Attended blocker',
    project,
    kind: 'task',
    hitl: 'yes',
    blockedBy: [],
    body: '',
  });
  const dependent = blockedTicket(1, 2);
  const source = fakeSource([dependent, attendedBlocker]);
  const layer = Layer.mergeAll(source.layer, HarnessSelectorNoop, capturingImplementation(ran));

  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* runEngine({ project, watch: true }).pipe(Effect.provide(layer), Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust('0 millis');
      expect(ran).toEqual([]);
      expect(source.doneReported).toEqual([]);
      source.add(seenAsDone(attendedBlocker));
      yield* TestClock.adjust('10 seconds');
      expect(ran).toEqual([dependent]);
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(TestClock.layer()))
  );

  expect(source.doneReported).toEqual([id(1)]);
});

test('runEngine keeps a ticket blocked by a blocker that the Source cannot find', async () => {
  const ran: Ticket[] = [];
  const source = fakeSource([blockedTicket(1, 99), seenAsDone(sampleTicket(2))]);
  const layer = Layer.mergeAll(source.layer, HarnessSelectorNoop, capturingImplementation(ran));

  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* runEngine().pipe(Effect.provide(layer), Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust('0 millis');
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(TestClock.layer()))
  );

  expect(ran).toEqual([]);
});

test('runEngine prints the unreadable tickets and folders, the unresolved blockers, and the files without a numeric prefix at start, then takes its Eligible tickets', async () => {
  const ran: Ticket[] = [];
  const messages: string[] = [];
  const unreadable = [
    UnreadableTicket.make({ name: 'README.md', reason: 'no numeric prefix' }),
    UnreadableTicket.make({ name: 'web/notes.md', reason: 'no numeric prefix' }),
    UnreadableTicket.make({
      name: '07-broken.md',
      id: id(7),
      reason: 'unparseable front matter',
      detail: 'it has no closing `---`',
    }),
    UnreadableTicket.make({
      name: '08-unknown-kind.md',
      id: id(8),
      reason: 'invalid hint',
      detail: 'Expected "implementation" | "research", got "chore" at ["kind"]',
    }),
    UnreadableTicket.make({
      name: 'web/',
      reason: 'folder cannot be read',
      detail: 'PermissionDenied: FileSystem.readDirectory (/repo/tickets/web)',
    }),
    UnreadableTicket.make({
      name: '09-locked.md',
      id: id(9),
      reason: 'file cannot be read',
      detail: 'PermissionDenied: FileSystem.readFile (/repo/tickets/09-locked.md)',
    }),
  ];
  const source = fakeSource(
    [
      blockedTicket(3, 99),
      blockedTicket(4, 5),
      Ticket.create({ ...sampleFields(5), hitl: 'yes' }),
      sampleTicket(6),
    ],
    { unreadable }
  );
  const layer = Layer.mergeAll(
    source.layer,
    HarnessSelectorNoop,
    capturingImplementation(ran),
    Layer.succeed(Console.Console, capturingConsole(messages))
  );

  expect(await runUntil(runEngine({ project }).pipe(Effect.provide(layer)), () => ran.length === 1)).toBeUndefined();
  expect(messages.slice(0, 6)).toEqual([
    'folder:7 (07-broken.md) is unreadable and is not taken: unparseable front matter: it has no closing `---`',
    'folder:8 (08-unknown-kind.md) is unreadable and is not taken: invalid hint: Expected "implementation" | "research", got "chore" at ["kind"]',
    'web/ is unreadable, so none of its tickets is taken: folder cannot be read: PermissionDenied: FileSystem.readDirectory (/repo/tickets/web)',
    'folder:9 (09-locked.md) is unreadable and is not taken: file cannot be read: PermissionDenied: FileSystem.readFile (/repo/tickets/09-locked.md)',
    'folder:3 has a blocker that cannot be resolved, so it stays blocked: folder:99',
    '2 files have no numeric prefix, so they are not read as tickets',
  ]);
  expect(ran).toEqual([sampleTicket(6)]);
});

test('runEngine prints nothing at start when every ticket is readable and every blocker resolves', async () => {
  const ran: Ticket[] = [];
  const messages: string[] = [];
  const layer = Layer.mergeAll(
    fakeSource([sampleTicket(1), blockedTicket(2, 1)]).layer,
    HarnessSelectorNoop,
    capturingImplementation(ran),
    Layer.succeed(Console.Console, capturingConsole(messages))
  );

  expect(await runUntil(runEngine({ project }).pipe(Effect.provide(layer)), () => ran.length === 2)).toBeUndefined();
  expect(messages.filter((message) => /unreadable|cannot be resolved|numeric prefix/.test(message))).toEqual([]);
});

// A ticket in the template of a standard ticket-writing skill, with no front matter.
const standardTemplate = (number: string, title: string, blockedBy: string) =>
  [
    `# ${number}: ${title}`,
    '',
    `**What to build:** ${title.toLowerCase()}.`,
    '',
    `**Blocked by:** ${blockedBy}`,
    '',
    '**Status:** ready-for-agent',
    '',
    '- [ ] It is built.',
    '',
  ].join('\n');

test('runEngine processes a chain of tickets in the standard template in dependency order', async () => {
  const ran: Ticket[] = [];
  const ticketsDir = await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectory({ prefix: 'engine-chain-' });
      yield* fs.writeFileString(path.join(dir, '01-last.md'), standardTemplate('01', 'Last', '02 (Middle)'));
      yield* fs.writeFileString(path.join(dir, '02-middle.md'), standardTemplate('02', 'Middle', '03 (First)'));
      yield* fs.writeFileString(path.join(dir, '03-first.md'), standardTemplate('03', 'First', 'None (can start immediately)'));
      return dir;
    }).pipe(Effect.provide(NodeServices.layer))
  );
  const folderSource = TicketSourceFolderLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        ConfigProvider.layer(ConfigProvider.fromUnknown({ ticketsDir })),
        Layer.succeed(RepositoryRoot, '/repo'),
        NodeServices.layer
      )
    )
  );
  const layer = Layer.mergeAll(folderSource, HarnessSelectorNoop, capturingImplementation(ran));

  expect(await Effect.runPromise(runEngine({ limit: 3 }).pipe(Effect.provide(layer)))).toBeUndefined();
  expect(ran.map((ticket) => [ticket.id, ticket.title])).toEqual([
    [id(3), 'First'],
    [id(2), 'Middle'],
    [id(1), 'Last'],
  ]);
});

test('the Project of runEngine narrows by the Project that a feature folder gives its tickets', async () => {
  const ran: Ticket[] = [];
  const ticketsDir = await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectory({ prefix: 'engine-features-' });
      yield* fs.makeDirectory(path.join(dir, 'auth'));
      yield* fs.makeDirectory(path.join(dir, 'billing'));
      yield* fs.writeFileString(path.join(dir, '01-root.md'), standardTemplate('01', 'Root', 'None'));
      yield* fs.writeFileString(path.join(dir, 'auth', '01-login.md'), standardTemplate('01', 'Login', 'None'));
      yield* fs.writeFileString(path.join(dir, 'auth', '02-logout.md'), standardTemplate('02', 'Logout', '01 (Login)'));
      yield* fs.writeFileString(path.join(dir, 'billing', '01-invoice.md'), standardTemplate('01', 'Invoice', 'None'));
      return dir;
    }).pipe(Effect.provide(NodeServices.layer))
  );
  const folderSource = TicketSourceFolderLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        ConfigProvider.layer(ConfigProvider.fromUnknown({ ticketsDir })),
        Layer.succeed(RepositoryRoot, '/repo'),
        NodeServices.layer
      )
    )
  );
  const layer = Layer.mergeAll(folderSource, HarnessSelectorNoop, capturingImplementation(ran));
  const auth = Schema.decodeSync(Project)('auth');

  expect(await Effect.runPromise(runEngine({ project: auth, limit: 2 }).pipe(Effect.provide(layer)))).toBeUndefined();
  expect(ran.map((ticket) => [ticket.id, ticket.project])).toEqual([
    [formatTicketId('folder', 'auth/1'), auth],
    [formatTicketId('folder', 'auth/2'), auth],
  ]);
});

test('runEngine resolves a blocker of another Project against every ticket of the Source', async () => {
  const ran: Ticket[] = [];
  const otherProject = Schema.decodeSync(Project)('other');
  const elsewhere = (value: number) =>
    Ticket.create({
      id: id(value),
      title: 'Ticket of another project',
      project: otherProject,
      kind: 'implementation',
      blockedBy: [],
      body: '',
    });
  const doneElsewhere = seenAsDone(elsewhere(2));
  const openElsewhere = elsewhere(4);
  const source = fakeSource([blockedTicket(1, 2), blockedTicket(3, 4), doneElsewhere, openElsewhere]);
  const layer = Layer.mergeAll(source.layer, HarnessSelectorNoop, capturingImplementation(ran));

  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* runEngine({ project }).pipe(Effect.provide(layer), Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust('0 millis');
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(TestClock.layer()))
  );

  expect(ran.map((ticket) => ticket.id)).toEqual([id(1)]);
});

test('runEngine keeps the Claim that the Source cannot confirm until it exits, takes another ticket, and reports released on exit', async () => {
  const ledger = makeLedgerMemory();
  const seen: Array<Claim | undefined> = [];
  const unconfirmed: Array<Claim | undefined> = [];
  const source = fakeSource([sampleTicket(1), sampleTicket(2)], {
    report: (ticket, event) =>
      ticket === id(1) && event === 'claimed'
        ? Effect.fail(new TicketEventNotReported({ ticketId: ticket, event }))
        : Effect.void,
  });
  // While a Runner processes ticket 2, the Ledger still holds the Claim on ticket 1.
  const recordUnconfirmed = Effect.sync(() => {
    unconfirmed.push(ledger.claims.get(id(1)));
  });
  const layer = Layer.mergeAll(
    source.layer,
    HarnessSelectorNoop,
    claimRecordingImplementation(ledger, seen, recordUnconfirmed)
  );

  expect(await Effect.runPromise(runEngine({ project, limit: 1 }, ledger).pipe(Effect.provide(layer)))).toBeUndefined();
  expect(seen.map((claim) => claim?.ticket)).toEqual([id(2)]);
  expect(unconfirmed.map((claim) => claim?.engine)).toEqual([engineId]);
  expect(ledger.claims.has(id(1))).toBe(false);
  expect(source.reports).toEqual([
    { ticket: id(2), event: 'claimed' },
    { ticket: id(1), event: 'released' },
  ]);
});

const failingStrategy = Layer.succeed(StrategySelector, {
  select: () =>
    Effect.succeed({
      name: 'implementation',
      run: () => Effect.succeed(Result.fail(new StrategyRuntimeError({ step: 1, failure: 'Harness error' }))),
    }),
});

test('runEngine records an escalation in the Ledger, reports no done to the Source, and halts when the strategy fails', () => {
  const ledger = makeLedgerMemory();
  const source = fakeSource([sampleTicket(1), sampleTicket(2)]);
  const layer = Layer.mergeAll(source.layer, HarnessSelectorNoop, failingStrategy);

  expect(Effect.runSync(runEngine({ project }, ledger).pipe(Effect.provide(layer), Effect.flip))).toEqual(
    new EngineHalted({ ticketId: id(1), reason: 'strategy failure: step 1, Harness error' })
  );
  expect([...ledger.escalated.values()]).toEqual([
    Escalation.make({
      ticket: id(1),
      reason: 'strategy failure: step 1, Harness error',
      attempts: 1,
      worktree: '/repo/.sandcastle/worktrees/ticket-folder-1',
    }),
  ]);
  expect(source.doneReported).toEqual([]);
  expect(ledger.done.size).toBe(0);
  expect(source.store.get(id(1))).toEqual(sampleTicket(1));
  expect(ledger.claims.size).toBe(0);
  expect(source.reports).toEqual([
    { ticket: id(1), event: 'claimed' },
    { ticket: id(1), event: 'escalated' },
  ]);
});

test('runEngine does not take a ticket that an earlier Engine run escalated', async () => {
  const ran: Ticket[] = [];
  const ledger = makeLedgerMemory();
  const source = fakeSource([sampleTicket(1), sampleTicket(2)]);

  expect(
    Effect.runSync(
      runEngine({ project }, ledger).pipe(
        Effect.provide(Layer.mergeAll(source.layer, HarnessSelectorNoop, failingStrategy)),
        Effect.flip
      )
    )
  ).toBeInstanceOf(EngineHalted);
  const later = Layer.mergeAll(source.layer, HarnessSelectorNoop, capturingImplementation(ran));
  expect(await Effect.runPromise(runEngine({ project, limit: 1 }, ledger).pipe(Effect.provide(later)))).toBeUndefined();

  expect(ran.map((ticket) => ticket.id)).toEqual([id(2)]);
  expect(ledger.escalated.has(id(1))).toBe(true);
});

test('runEngine takes a retried ticket again, in its retained Ticket Worktree', async () => {
  const ran: Ticket[] = [];
  const prepared: string[] = [];
  const ledger = makeLedgerMemory();
  const source = fakeSource([sampleTicket(1), sampleTicket(2)]);
  const recordingWorktrees = Layer.succeed(WorktreeManager, {
    prepareProject: (value) => Effect.succeed({ path: `/repo/.sandcastle/worktrees/${value}`, branch: value }),
    prepareTicket: ({ id: ticket }) =>
      Effect.sync(() => {
        const worktree = ticketWorktreeOf(ticket);
        prepared.push(worktree.path);
        return worktree;
      }),
    runCommand: () => Effect.die('runCommand should not be called'),
    changedPaths: () => Effect.succeed([]),
    mergeAndClose: () => Effect.void,
  });

  expect(
    Effect.runSync(
      runEngine({ project }, ledger).pipe(
        Effect.provide(Layer.mergeAll(source.layer, HarnessSelectorNoop, failingStrategy)),
        Effect.flip
      )
    )
  ).toBeInstanceOf(EngineHalted);
  await Effect.runPromise(retryTicket({ ticket: id(1) }).pipe(Effect.provide(Layer.merge(source.layer, ledger.layer))));
  const later = Layer.mergeAll(
    EngineStartupTest,
    recordingWorktrees,
    ledger.layer,
    source.layer,
    HarnessSelectorNoop,
    capturingImplementation(ran)
  );
  expect(
    await Effect.runPromise(
      executeEngine({ project, limit: 1 }).pipe(Random.withSeed('test'), Effect.provide(later))
    )
  ).toBeUndefined();

  expect(ran.map((ticket) => ticket.id)).toEqual([id(1)]);
  expect(prepared).toEqual([ledger.cleared.get(id(1))?.worktree]);
  expect(ledger.escalated.has(id(1))).toBe(false);
});

test('runEngine does not process a ticket that another Engine escalated after this Engine read the Ledger', async () => {
  const ran: Ticket[] = [];
  const ledger = makeLedgerMemory();
  const source = fakeSource([sampleTicket(1), sampleTicket(2)]);
  // The poll reads the Escalations before another Engine escalates ticket 1 and
  // releases its Claim, so the read misses that Escalation.
  const real = Effect.runSync(Ledger.pipe(Effect.provide(ledger.layer)));
  let reads = 0;
  const lateEscalation = Layer.succeed(Ledger, {
    ...real,
    escalations: (tickets) =>
      reads++ === 0
        ? real.escalations(tickets).pipe(
            Effect.tap(() =>
              real.escalate(id(1), { reason: 'strategy failure', worktree: '/repo/.sandcastle/worktrees/ticket-folder:1' })
            )
          )
        : real.escalations(tickets),
  });
  const layer = Layer.mergeAll(source.layer, HarnessSelectorNoop, capturingImplementation(ran));

  expect(
    await Effect.runPromise(
      executeEngine({ project, limit: 1 }).pipe(
        Random.withSeed('test'),
        Effect.provide(Layer.mergeAll(EngineStartupTest, lateEscalation, layer))
      )
    )
  ).toBeUndefined();
  expect(ran.map((ticket) => ticket.id)).toEqual([id(2)]);
  expect(ledger.claims.has(id(1))).toBe(false);
  expect(source.reports).toEqual([{ ticket: id(2), event: 'claimed' }]);
});

// A Worktree Manager whose merge of a Ticket Worktree records each step in the
// timeline, and fails when `merge` says so.
const timelineWorktrees = (timeline: string[], merge: Effect.Effect<void, WorktreeCloseError> = Effect.void) =>
  Layer.succeed(WorktreeManager, {
    prepareProject: (value) => Effect.succeed({ path: `/repo/.sandcastle/worktrees/${value}`, branch: value }),
    prepareTicket: ({ id: ticket }) =>
      Effect.succeed({ path: `/repo/.sandcastle/worktrees/ticket-${ticket}`, branch: `ticket-${ticket}` }),
    runCommand: () => Effect.die('runCommand should not be called'),
    changedPaths: () => Effect.succeed([]),
    mergeAndClose: () =>
      Effect.sync(() => {
        timeline.push('merge and close');
      }).pipe(Effect.andThen(merge)),
  });

// The memory Ledger, recording in the timeline each done it records and each
// Claim it releases.
const timelineLedger = (timeline: string[]) => {
  const ledger = makeLedgerMemory();
  const real = Effect.runSync(Ledger.pipe(Effect.provide(ledger.layer)));
  const layer = Layer.succeed(Ledger, {
    ...real,
    recordDone: (ticket) =>
      Effect.sync(() => {
        timeline.push(`done in the Ledger ${ticket}`);
      }).pipe(Effect.andThen(real.recordDone(ticket))),
    release: (ticket) =>
      Effect.sync(() => {
        timeline.push(`Claim released ${ticket}`);
      }).pipe(Effect.andThen(real.release(ticket))),
  });
  return { ...ledger, layer };
};

test('runEngine does not process a ticket that another Engine completed after this Engine read the Ledger', async () => {
  const ran: Ticket[] = [];
  const ledger = makeLedgerMemory();
  const source = fakeSource([sampleTicket(1), sampleTicket(2)]);
  // The poll reads done before another Engine records ticket 1 as done and
  // releases its Claim, so the read misses that done.
  const real = Effect.runSync(Ledger.pipe(Effect.provide(ledger.layer)));
  let reads = 0;
  const lateDone = Layer.succeed(Ledger, {
    ...real,
    done: (tickets) =>
      reads++ === 0 ? real.done(tickets).pipe(Effect.tap(() => real.recordDone(id(1)))) : real.done(tickets),
  });
  const layer = Layer.mergeAll(source.layer, HarnessSelectorNoop, capturingImplementation(ran));

  expect(
    await Effect.runPromise(
      executeEngine({ project, limit: 1 }).pipe(
        Random.withSeed('test'),
        Effect.provide(Layer.mergeAll(EngineStartupTest, lateDone, layer))
      )
    )
  ).toBeUndefined();
  expect(ran.map((ticket) => ticket.id)).toEqual([id(2)]);
  expect(ledger.claims.has(id(1))).toBe(false);
  expect(source.reports).toEqual([{ ticket: id(2), event: 'claimed' }]);
});

test('runEngine keeps the Claim on a ticket completed since the read when it could not report the release of the Stale Claim it replaced', async () => {
  const ran: Ticket[] = [];
  const ledger = makeLedgerMemory();
  ledger.claims.set(id(1), Claim.make({ ticket: id(1), engine: otherEngine, process: 2, host: 'memory' }));
  const source = fakeSource([sampleTicket(1), sampleTicket(2)], {
    report: (ticket, event) =>
      event === 'released' ? Effect.fail(new TicketEventNotReported({ ticketId: ticket, event })) : Effect.void,
  });
  // Another Engine records ticket 1 as done after the poll read the Ledger, as this
  // Engine replaces its Stale Claim.
  const real = Effect.runSync(Ledger.pipe(Effect.provide(ledger.layer)));
  const lateDone = Layer.succeed(Ledger, {
    ...real,
    replaceStale: (stale, engine) => real.replaceStale(stale, engine).pipe(Effect.tap(() => real.recordDone(id(1)))),
  });
  const layer = Layer.mergeAll(source.layer, HarnessSelectorNoop, capturingImplementation(ran));

  expect(
    await Effect.runPromise(
      executeEngine({ project, limit: 1 }).pipe(
        Random.withSeed('test'),
        Effect.provide(Layer.mergeAll(EngineStartupTest, lateDone, layer))
      )
    )
  ).toBeUndefined();
  expect(ran.map((ticket) => ticket.id)).toEqual([id(2)]);
  // The Claim stayed until the exit, which reported the end state that the Ledger
  // shows, done, in place of the release that had failed.
  expect(ledger.claims.has(id(1))).toBe(false);
  expect(source.reports).toContainEqual({ ticket: id(1), event: 'done' });
  expect(source.reports).not.toContainEqual({ ticket: id(1), event: 'released' });
});

test('runEngine reports done to the Source, merges and closes, records done in the Ledger, finishes the Source, then releases the Claim', async () => {
  const timeline: string[] = [];
  const ledger = timelineLedger(timeline);
  const source = fakeSource([sampleTicket(1)], {
    reportDone: (ticket) =>
      Effect.sync((): AfterMerge => {
        timeline.push(`done reported ${ticket}`);
        return Effect.sync(() => {
          timeline.push(`after the merge ${ticket}`);
        });
      }),
  });
  const layer = Layer.mergeAll(
    EngineStartupTest,
    timelineWorktrees(timeline),
    ledger.layer,
    source.layer,
    HarnessSelectorNoop,
    StrategySelectorNoop
  );

  expect(
    await Effect.runPromise(executeEngine({ project, limit: 1 }).pipe(Random.withSeed('test'), Effect.provide(layer)))
  ).toBeUndefined();
  expect(timeline).toEqual([
    `done reported ${id(1)}`,
    'merge and close',
    `done in the Ledger ${id(1)}`,
    `after the merge ${id(1)}`,
    `Claim released ${id(1)}`,
  ]);
});

test('runEngine never runs what the Source leaves for after the merge when the merge fails, records no done in the Ledger, halts, and releases its Claim on exit', async () => {
  const timeline: string[] = [];
  const ledger = makeLedgerMemory();
  const source = fakeSource([sampleTicket(1), sampleTicket(2)], {
    reportDone: () =>
      Effect.succeed(
        Effect.sync(() => {
          timeline.push('after the merge');
        })
      ),
  });
  const layer = Layer.mergeAll(
    EngineStartupTest,
    timelineWorktrees(timeline, Effect.fail(new WorktreeCloseError())),
    ledger.layer,
    source.layer,
    HarnessSelectorNoop,
    StrategySelectorNoop
  );

  expect(
    await Effect.runPromise(executeEngine({ project }).pipe(Random.withSeed('test'), Effect.provide(layer), Effect.flip))
  ).toEqual(new EngineHalted({ ticketId: id(1), reason: 'worktree close failure' }));
  expect(timeline).toEqual(['merge and close', 'merge and close']);
  expect(timeline).not.toContain('after the merge');
  expect(source.doneReported).toEqual([id(1)]);
  expect(ledger.done.size).toBe(0);
  expect(ledger.claims.size).toBe(0);
  expect(source.reports).toEqual([
    { ticket: id(1), event: 'claimed' },
    { ticket: id(1), event: 'released' },
  ]);
});

// Git in a directory, with its output. A non-zero exit does not fail.
const gitIn = (cwd: string, args: readonly string[]) =>
  ChildProcessSpawner.ChildProcessSpawner.pipe(
    Effect.flatMap((spawner) => spawner.string(ChildProcess.make('git', args, { cwd })))
  );

const commitIn = (root: string, file: string, text: string, message: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.writeFileString(path.join(root, file), text);
    yield* gitIn(root, ['commit', '-am', message]);
  });

// A run of one ticket in a new repository, with the Worktree Manager, whose
// Agent commits the work in the Ticket Worktree and then does `meanwhile` in the
// Repository Root, so the merge fails.
const runWithFailedMerge = (
  meanwhile: (
    root: string
  ) => Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner>
) => {
  const ledger = makeLedgerMemory();
  const messages: string[] = [];
  return Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({ prefix: 'engine-merge-failure-' });
      const ticketsDir = path.join(root, '.agents', 'tickets');
      const ticketFile = path.join(ticketsDir, '01-conflict.md');
      const content = standardTemplate('01', 'Conflict', 'None (can start immediately)');
      yield* gitIn(root, ['init', '-b', 'main']);
      yield* gitIn(root, ['config', 'user.email', 'test@test.com']);
      yield* gitIn(root, ['config', 'user.name', 'Test']);
      yield* fs.makeDirectory(ticketsDir, { recursive: true });
      yield* fs.writeFileString(ticketFile, content);
      yield* fs.writeFileString(path.join(root, '.gitignore'), '.sandcastle/\n.agents/\n');
      yield* fs.writeFileString(path.join(root, 'base.txt'), 'from main\n');
      yield* gitIn(root, ['add', '-A']);
      yield* gitIn(root, ['commit', '-m', 'init']);
      const harnessThenMeanwhile: Harness = {
        name: 'then-meanwhile',
        model: 'test-model',
        run: (_prompt, options) =>
          Effect.gen(function* () {
            yield* fs.writeFileString(path.join(options.cwd!, 'base.txt'), 'the work\n');
            yield* gitIn(options.cwd!, ['commit', '-am', 'feat: the work']);
            yield* meanwhile(root);
            return { completionSignal: undefined };
          }).pipe(Effect.provide(NodeServices.layer), Effect.orDie),
      };
      const layer = Layer.mergeAll(
        TicketSourceFolderLive.pipe(
          Layer.provide(Layer.merge(ConfigProvider.layer(ConfigProvider.fromUnknown({ ticketsDir })), gitRootOf(root)))
        ),
        WorktreeManagerLive(root),
        gitRootOf(root),
        ledger.layer,
        Layer.succeed(HarnessSelector, { select: Effect.succeed(harnessThenMeanwhile) }),
        StrategySelectorNoop,
        Layer.succeed(Console.Console, capturingConsole(messages))
      );
      const halt = yield* executeEngine({}).pipe(Random.withSeed('test'), Effect.provide(layer), Effect.flip);
      return {
        root,
        halt,
        content,
        messages,
        ledger,
        inPlace: yield* fs.readFileString(ticketFile),
        inDone: yield* fs.exists(path.join(ticketsDir, 'done')),
        mergeInProgress: yield* fs.exists(path.join(root, '.git', 'MERGE_HEAD')),
        rootContent: yield* fs.readFileString(path.join(root, 'base.txt')),
        rootHead: (yield* gitIn(root, ['log', '-1', '--format=%s'])).trim(),
      };
    }).pipe(Effect.provide(NodeServices.layer))
  );
};

test('runEngine leaves the ticket file in place, records no done in the Ledger, and logs what Git wrote when the merge of the Worktree Manager conflicts', async () => {
  // Another change to the file the work changed lands in the Repository Root.
  const result = await runWithFailedMerge((root) => commitIn(root, 'base.txt', 'other work\n', 'feat: other work'));

  expect(result.halt).toEqual(new EngineHalted({ ticketId: id(1), reason: 'worktree close failure' }));
  expect(result.messages).toContainEqual(
    expect.stringContaining('CONFLICT (content): Merge conflict in base.txt')
  );
  expect(result.inPlace).toBe(result.content);
  expect(result.inDone).toBe(false);
  expect(result.ledger.done.size).toBe(0);
  expect(result.ledger.claims.size).toBe(0);
  expect(result.mergeInProgress).toBe(false);
  expect(result.rootContent).toBe('other work\n');
  expect(result.rootHead).toBe('feat: other work');
});

test('runEngine halts with the same reason, and logs that a merge is in progress, when a person left a merge in progress in the Repository Root', async () => {
  // A person merges a branch that conflicts with main, and leaves the merge in progress.
  const result = await runWithFailedMerge((root) =>
    Effect.gen(function* () {
      yield* gitIn(root, ['checkout', '-b', 'side']);
      yield* commitIn(root, 'base.txt', 'from side\n', 'feat: side');
      yield* gitIn(root, ['checkout', 'main']);
      yield* commitIn(root, 'base.txt', 'other work\n', 'feat: other work');
      yield* gitIn(root, ['merge', 'side']);
    })
  );

  expect(result.halt).toEqual(new EngineHalted({ ticketId: id(1), reason: 'worktree close failure' }));
  expect(result.messages).toContain(
    `Worktree ticket-folder-1 is not merging: a merge is in progress at ${result.root}`
  );
  expect(result.inPlace).toBe(result.content);
  expect(result.inDone).toBe(false);
  expect(result.ledger.done.size).toBe(0);
  expect(result.mergeInProgress).toBe(true);
});

test('runEngine does not take a Project ticket that the Ledger records as done while its file is still open, and takes its dependent', async () => {
  const ran: Ticket[] = [];
  const ledger = makeLedgerMemory();
  ledger.done.add(id(1));
  const source = fakeSource([sampleTicket(1), blockedTicket(2, 1)]);
  const layer = Layer.mergeAll(source.layer, HarnessSelectorNoop, capturingImplementation(ran));

  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* runEngine({ project }, ledger).pipe(
        Effect.provide(layer),
        Effect.forkChild({ startImmediately: true })
      );
      yield* TestClock.adjust('10 seconds');
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(TestClock.layer()))
  );

  expect(source.store.get(id(1))?.doneInSource).toBe(false);
  expect(ran.map((ticket) => ticket.id)).toEqual([id(2)]);
  expect(source.reports).toEqual([{ ticket: id(2), event: 'claimed' }]);
});

test('runEngine in a Watch keeps polling when the provided repository has no ticket', async () => {
  const source = fakeSource();
  const layer = Layer.mergeAll(
    source.layer,
    HarnessSelectorNoop,
    StrategySelectorNoop
  );

  await Effect.runPromise(
    Effect.gen(function* () {
      yield* runEngine({ project, watch: true }).pipe(Effect.forkChild({ startImmediately: true }));
      expect(source.scopeReads.length).toBe(startRead + 1);
      yield* TestClock.adjust('10 seconds');
      expect(source.scopeReads.length).toBe(startRead + 2);
      yield* TestClock.adjust('10 seconds');
      expect(source.scopeReads.length).toBe(startRead + 3);
    }).pipe(Effect.provide(Layer.mergeAll(layer, TestClock.layer())))
  );
});

test('runEngine stops after processing the given limit length', async () => {
  const first = sampleTicket(1);
  const second = sampleTicket(2);
  const third = sampleTicket(3);
  const ran: Ticket[] = [];
  const layer = Layer.mergeAll(
    fakeSource([first, second, third]).layer,
    HarnessSelectorNoop,
    capturingImplementation(ran)
  );

  expect(
    await Effect.runPromise(
      runEngine({ project, limit: 2 }).pipe(Effect.provide(Layer.mergeAll(layer, TestClock.layer())))
    )
  ).toBeUndefined();
  expect(ran).toEqual([first, second]);
});

test('runEngine starts one runner by default and names it in the Claim with an engine-derived id', async () => {
  const ledger = makeLedgerMemory();
  const seen: Array<Claim | undefined> = [];
  const layer = Layer.mergeAll(fakeSource([sampleTicket(1)]).layer, HarnessSelectorNoop, claimRecordingImplementation(ledger, seen));

  expect(await Effect.runPromise(runEngine({ project, limit: 1 }, ledger).pipe(Effect.provide(layer)))).toBeUndefined();
  expect(seen.map((claim) => [claim?.engine, claim?.runner])).toEqual([[engineId, claiming]]);
});

test('runEngine in a Watch reads the Source at the given pollInterval when empty', async () => {
  const source = fakeSource();
  await Effect.runPromise(
    Effect.gen(function* () {
      const layer = Layer.mergeAll(
        source.layer,
        HarnessSelectorNoop,
        StrategySelectorNoop
      );
      yield* runEngine({ project, watch: true, pollInterval: '2 seconds' }).pipe(
        Effect.provide(layer),
        Effect.forkChild({ startImmediately: true })
      );
      expect(source.scopeReads.length).toBe(startRead + 1);
      yield* TestClock.adjust('1999 millis');
      expect(source.scopeReads.length).toBe(startRead + 1);
      yield* TestClock.adjust('1 millis');
      expect(source.scopeReads.length).toBe(startRead + 2);
    }).pipe(Effect.provide(TestClock.layer()))
  );
});

test('runEngine in a Watch reads the Source once every 10 seconds when empty regardless of runner concurrency', async () => {
  const source = fakeSource();
  await Effect.runPromise(
    Effect.gen(function* () {
      const layer = Layer.mergeAll(
        source.layer,
        HarnessSelectorNoop,
        StrategySelectorNoop
      );
      yield* runEngine({ project, watch: true, concurrency: 3, workspace: 'worktree' }).pipe(
        Effect.provide(layer),
        Effect.forkChild({ startImmediately: true })
      );
      yield* TestClock.adjust('0 millis');
      expect(source.scopeReads.length).toBe(startRead + 1);
      yield* TestClock.adjust('10 seconds');
      expect(source.scopeReads.length).toBe(startRead + 2);
      yield* TestClock.adjust('10 seconds');
      expect(source.scopeReads.length).toBe(startRead + 3);
    }).pipe(Effect.provide(TestClock.layer()))
  );
});

test('runEngine claims queued tickets with distinct runners when concurrency allows', async () => {
  const ledger = makeLedgerMemory();
  const seen: Array<Claim | undefined> = [];
  const layer = Layer.mergeAll(
    fakeSource([sampleTicket(1), sampleTicket(2)]).layer,
    HarnessSelectorNoop,
    claimRecordingImplementation(ledger, seen)
  );

  expect(
    await Effect.runPromise(runEngine({ project, limit: 2, concurrency: 2, workspace: 'worktree' }, ledger).pipe(Effect.provide(layer)))
  ).toBeUndefined();
  expect(new Set(seen.map((claim) => claim?.runner))).toEqual(new Set([claiming, runnerIdFrom(engineId, '1')]));
});

test('runEngine stops reading at the limit length', async () => {
  const first = sampleTicket(1);
  const second = sampleTicket(2);
  const third = sampleTicket(3);
  const ran: Ticket[] = [];
  const source = fakeSource([first, second, third]);
  const layer = Layer.mergeAll(
    source.layer,
    capturingImplementation(ran),
    HarnessSelectorNoop
  );

  expect(
    await Effect.runPromise(runEngine({ project, limit: 2 }).pipe(Effect.provide(layer)))
  ).toBeUndefined();
  expect(ran).toHaveLength(2);
  expect(ran).toEqual([first, second]);
  expect(source.scopeReads).toHaveLength(startRead + 2);
});

test('runEngine claims a single unblocked ticket once', async () => {
  const ran: Ticket[] = [];
  // Ticket 2 is blocked by ticket 99, which this run never completes, so it stays
  // unavailable. The decoy checks that two workers do not claim ticket 1 twice; it
  // must not depend on ticket 1, because completing ticket 1 would unblock it.
  const { layer: repo, store } = fakeSource([sampleTicket(1), blockedTicket(2, 99)]);
  const layer = Layer.mergeAll(repo, HarnessSelectorNoop, capturingImplementation(ran));

  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* runEngine({ project, concurrency: 2, workspace: 'worktree' }).pipe(
        Effect.provide(layer),
        Effect.forkChild({ startImmediately: true })
      );
      yield* TestClock.adjust('0 millis');
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(TestClock.layer()))
  );

  expect(ran.map((ticket) => ticket.id)).toEqual([id(1)]);
  expect(store.get(id(2))?.doneInSource).toBe(false);
});

test('runEngine replaces a Stale Claim with the one replace operation of the Ledger, and holds the new Claim', async () => {
  const ledger = makeLedgerMemory();
  const seen: Array<Claim | undefined> = [];
  const source = fakeSource([sampleTicket(1)]);
  const stale = Claim.make({ ticket: id(1), engine: otherEngine, process: 2, host: 'memory' });
  ledger.claims.set(id(1), stale);
  // Every operation of the Ledger that makes, removes, or replaces a Claim.
  const real = Effect.runSync(Ledger.pipe(Effect.provide(ledger.layer)));
  const operations: unknown[][] = [];
  const recorded = <A, E>(operation: unknown[], effect: Effect.Effect<A, E>) =>
    Effect.sync(() => operations.push(operation)).pipe(Effect.andThen(effect));
  const recordingOperations = Layer.succeed(Ledger, {
    ...real,
    claim: (ticket, engine) => recorded(['claim', ticket], real.claim(ticket, engine)),
    release: (ticket) => recorded(['release', ticket], real.release(ticket)),
    replaceStale: (claim, engine) => recorded(['replaceStale', claim, engine], real.replaceStale(claim, engine)),
  });
  // The operations made before a Runner processes the ticket.
  const beforeProcessing: unknown[][] = [];
  const recordOperations = Effect.sync(() => {
    beforeProcessing.push(...operations);
  });
  const layer = Layer.mergeAll(
    source.layer,
    HarnessSelectorNoop,
    claimRecordingImplementation(ledger, seen, recordOperations)
  );

  expect(
    await Effect.runPromise(
      executeEngine({ project, limit: 1 }).pipe(
        Random.withSeed('test'),
        Effect.provide(Layer.mergeAll(EngineStartupTest, recordingOperations, layer))
      )
    )
  ).toBeUndefined();
  expect(beforeProcessing).toEqual([['replaceStale', stale, engineId]]);
  expect(seen.map((claim) => [claim?.ticket, claim?.engine, claim?.runner])).toEqual([[id(1), engineId, claiming]]);
});

test('runEngine replaces a stale Claim: it reports released before the new claimed, and takes the ticket', async () => {
  const ran: Ticket[] = [];
  const ledger = makeLedgerMemory();
  const source = fakeSource([sampleTicket(1)]);
  // The other Engine's process no longer runs on this host.
  ledger.claims.set(id(1), Claim.make({ ticket: id(1), engine: otherEngine, process: 2, host: 'memory' }));
  const layer = Layer.mergeAll(source.layer, HarnessSelectorNoop, capturingImplementation(ran));

  expect(await Effect.runPromise(runEngine({ project, limit: 1 }, ledger).pipe(Effect.provide(layer)))).toBeUndefined();
  expect(ran.map((ticket) => ticket.id)).toEqual([id(1)]);
  expect(source.reports).toEqual([
    { ticket: id(1), event: 'released' },
    { ticket: id(1), event: 'claimed' },
  ]);
});

test('runEngine reports released only when it wins the replacement of a Stale Claim that another Engine also replaces', async () => {
  const ledger = makeLedgerMemory();
  // The other Engine's process no longer runs on this host.
  ledger.claims.set(id(1), Claim.make({ ticket: id(1), engine: otherEngine, process: 2, host: 'memory' }));
  const replacements: boolean[] = [];
  const recordingReplacements = Layer.effect(
    Ledger,
    Ledger.pipe(
      Effect.map((inner) => ({
        ...inner,
        replaceStale: (claim: Claim, engine: EngineId) =>
          inner.replaceStale(claim, engine).pipe(Effect.tap((won) => Effect.sync(() => replacements.push(won)))),
      }))
    )
  ).pipe(Layer.provide(ledger.layer));
  const source = fakeSource([sampleTicket(1)]);
  // Both Engines read the ticket by identity, with the Stale Claim, before either replaces it.
  let identityReads = 0;
  const bothRead = Deferred.makeUnsafe<void>();
  const racingSource = Layer.effect(
    TicketSource,
    TicketSource.pipe(
      Effect.map((inner) => ({
        ...inner,
        getOneBy: (query: TicketQuery) =>
          inner.getOneBy(query).pipe(
            Effect.tap(() =>
              Effect.suspend(() => {
                identityReads += 1;
                return identityReads === 2 ? Deferred.succeed(bothRead, undefined) : Effect.void;
              }).pipe(Effect.andThen(Deferred.await(bothRead)))
            )
          ),
      }))
    )
  ).pipe(Layer.provide(source.layer));
  const hangingImplementation = Layer.succeed(StrategySelector, {
    select: () => Effect.succeed({ name: 'implementation', run: () => Effect.never }),
  });
  const engineOf = (seed: string) =>
    executeEngine({ project }).pipe(
      Random.withSeed(seed),
      Effect.provide(
        Layer.mergeAll(EngineStartupTest, recordingReplacements, racingSource, HarnessSelectorNoop, hangingImplementation)
      )
    );

  await Effect.runPromise(
    Effect.gen(function* () {
      const first = yield* engineOf('first').pipe(Effect.forkChild({ startImmediately: true }));
      const second = yield* engineOf('second').pipe(Effect.forkChild({ startImmediately: true }));
      yield* until(() => replacements.length === 2 && source.reports.length === 2);

      expect(replacements.toSorted((left, right) => Number(left) - Number(right))).toEqual([false, true]);
      expect(source.reports).toEqual([
        { ticket: id(1), event: 'released' },
        { ticket: id(1), event: 'claimed' },
      ]);
      yield* Fiber.interrupt(first);
      yield* Fiber.interrupt(second);
    })
  );
});

test('runEngine keeps its new Claim when the release of a Stale Claim fails, does not process the ticket, and releases the Claim on exit', async () => {
  const ledger = makeLedgerMemory();
  const seen: Array<Claim | undefined> = [];
  ledger.claims.set(id(1), Claim.make({ ticket: id(1), engine: otherEngine, process: 2, host: 'memory' }));
  // As on Linear, a failed release leaves the ticket claimed on the Source, so the
  // claimed report fails too. At exit, the release succeeds.
  let releases = 0;
  const source = fakeSource([sampleTicket(1), sampleTicket(2)], {
    report: (ticket, event) => {
      if (event === 'released') {
        releases += 1;
      }
      return ticket === id(1) && (event === 'claimed' || (event === 'released' && releases === 1))
        ? Effect.fail(new TicketEventNotReported({ ticketId: ticket, event }))
        : Effect.void;
    },
  });
  const layer = Layer.mergeAll(source.layer, HarnessSelectorNoop, claimRecordingImplementation(ledger, seen));

  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* runEngine({ project, watch: true }, ledger).pipe(
        Effect.provide(layer),
        Effect.forkChild({ startImmediately: true })
      );
      yield* until(() => source.doneReported.length === 1);

      expect(seen.map((claim) => claim?.ticket)).toEqual([id(2)]);
      expect(ledger.claims.get(id(1))?.engine).toBe(engineId);
      yield* Fiber.interrupt(fiber);
    })
  );

  expect(ledger.claims.has(id(1))).toBe(false);
  expect(source.reports).toEqual([
    { ticket: id(2), event: 'claimed' },
    { ticket: id(1), event: 'released' },
  ]);
});

// A Stale Claim of a stopped Engine on a ticket that the Ledger shows as escalated
// or done: its Engine could not report the end state.
const staleClaimOn = (ledger: ReturnType<typeof makeLedgerMemory>, ticket: TicketId) =>
  ledger.claims.set(ticket, Claim.make({ ticket, engine: otherEngine, process: 2, host: 'memory' }));

const escalationOf = (ticket: TicketId) =>
  Escalation.make({ ticket, reason: 'strategy failure', attempts: 1, worktree: `/repo/.sandcastle/worktrees/ticket-${ticket}` });

test('runEngine removes the Claim of an escalated ticket only after the Source accepts the escalated report', () => {
  const timeline: string[] = [];
  const ledger = timelineLedger(timeline);
  const source = fakeSource([sampleTicket(1), sampleTicket(2)], {
    report: (ticket, event) =>
      Effect.sync(() => {
        timeline.push(`${event} reported ${ticket}`);
      }),
  });
  const layer = Layer.mergeAll(source.layer, HarnessSelectorNoop, failingStrategy);

  expect(Effect.runSync(runEngine({ project }, ledger).pipe(Effect.provide(layer), Effect.flip))).toBeInstanceOf(
    EngineHalted
  );
  expect(timeline).toEqual([`claimed reported ${id(1)}`, `escalated reported ${id(1)}`, `Claim released ${id(1)}`]);
});

test('runEngine keeps the Claim of an escalated ticket when the escalated report fails, and the exit reports escalated again, then removes the record', () => {
  const timeline: string[] = [];
  const ledger = timelineLedger(timeline);
  let escalatedReports = 0;
  const source = fakeSource([sampleTicket(1), sampleTicket(2)], {
    report: (ticket, event) =>
      event === 'escalated' && escalatedReports++ === 0
        ? Effect.sync(() => {
            timeline.push(`escalated failed ${ticket}`);
          }).pipe(Effect.andThen(Effect.fail(new TicketEventNotReported({ ticketId: ticket, event }))))
        : Effect.sync(() => {
            timeline.push(`${event} reported ${ticket}`);
          }),
  });
  const layer = Layer.mergeAll(source.layer, HarnessSelectorNoop, failingStrategy);

  expect(Effect.runSync(runEngine({ project }, ledger).pipe(Effect.provide(layer), Effect.flip))).toBeInstanceOf(
    EngineHalted
  );
  expect(timeline).toEqual([
    `claimed reported ${id(1)}`,
    `escalated failed ${id(1)}`,
    `escalated reported ${id(1)}`,
    `Claim released ${id(1)}`,
  ]);
  expect(ledger.escalated.has(id(1))).toBe(true);
});

test('runEngine keeps the Claim of a done ticket when its completion on the Source fails after the merge, and the exit completes it again, then removes the record', async () => {
  const timeline: string[] = [];
  const ledger = timelineLedger(timeline);
  const source = fakeSource([sampleTicket(1)], {
    reportDone: (ticket) =>
      Effect.succeed(
        Effect.sync(() => {
          timeline.push(`after the merge failed ${ticket}`);
        }).pipe(Effect.andThen(Effect.fail(new TicketEventNotReported({ ticketId: ticket, event: 'done' }))))
      ),
    report: (ticket, event) =>
      Effect.sync(() => {
        timeline.push(`${event} reported ${ticket}`);
      }),
  });
  const layer = Layer.mergeAll(
    EngineStartupTest,
    timelineWorktrees(timeline),
    ledger.layer,
    source.layer,
    HarnessSelectorNoop,
    StrategySelectorNoop
  );

  expect(
    await Effect.runPromise(executeEngine({ project, limit: 1 }).pipe(Random.withSeed('test'), Effect.provide(layer)))
  ).toBeUndefined();
  expect(timeline).toEqual([
    `claimed reported ${id(1)}`,
    'merge and close',
    `done in the Ledger ${id(1)}`,
    `after the merge failed ${id(1)}`,
    `done reported ${id(1)}`,
    `Claim released ${id(1)}`,
  ]);
  expect(ledger.done.has(id(1))).toBe(true);
});

test('runEngine finishes the stopped saga of an escalated ticket on a Stale Claim: it reports escalated, removes the record, and does not take the ticket', async () => {
  const ran: Ticket[] = [];
  const ledger = makeLedgerMemory();
  staleClaimOn(ledger, id(1));
  ledger.escalated.set(id(1), escalationOf(id(1)));
  const source = fakeSource([sampleTicket(1), sampleTicket(2)]);
  const layer = Layer.mergeAll(source.layer, HarnessSelectorNoop, capturingImplementation(ran));

  expect(await Effect.runPromise(runEngine({ project, limit: 1 }, ledger).pipe(Effect.provide(layer)))).toBeUndefined();

  expect(ran.map((ticket) => ticket.id)).toEqual([id(2)]);
  expect(ledger.claims.has(id(1))).toBe(false);
  expect(ledger.escalated.has(id(1))).toBe(true);
  expect(source.reports).toEqual([
    { ticket: id(1), event: 'escalated' },
    { ticket: id(2), event: 'claimed' },
  ]);
});

test('runEngine finishes the stopped saga of a done ticket on a Stale Claim: it completes it on the Source, removes the record, and does not take the ticket', async () => {
  const ran: Ticket[] = [];
  const ledger = makeLedgerMemory();
  staleClaimOn(ledger, id(1));
  ledger.done.add(id(1));
  const source = fakeSource([sampleTicket(1), sampleTicket(2)]);
  const layer = Layer.mergeAll(source.layer, HarnessSelectorNoop, capturingImplementation(ran));

  expect(await Effect.runPromise(runEngine({ project, limit: 1 }, ledger).pipe(Effect.provide(layer)))).toBeUndefined();

  expect(ran.map((ticket) => ticket.id)).toEqual([id(2)]);
  expect(ledger.claims.has(id(1))).toBe(false);
  expect(source.reports).toEqual([
    { ticket: id(1), event: 'done' },
    { ticket: id(2), event: 'claimed' },
  ]);
});

test('runEngine keeps its Claim on a stopped saga whose end report fails, and reports it again on exit', async () => {
  const ledger = makeLedgerMemory();
  staleClaimOn(ledger, id(1));
  ledger.done.add(id(1));
  let doneReports = 0;
  const source = fakeSource([sampleTicket(1), sampleTicket(2)], {
    report: (ticket, event) =>
      event === 'done' && doneReports++ === 0
        ? Effect.fail(new TicketEventNotReported({ ticketId: ticket, event }))
        : Effect.void,
  });
  const layer = Layer.mergeAll(source.layer, HarnessSelectorNoop, capturingImplementation([]));
  let heldBeforeExit: Claim | undefined;

  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* runEngine({ project, watch: true }, ledger).pipe(
        Effect.provide(layer),
        Effect.forkChild({ startImmediately: true })
      );
      yield* until(() => source.doneReported.length === 1);
      heldBeforeExit = ledger.claims.get(id(1));
      yield* Fiber.interrupt(fiber);
    })
  );

  expect(heldBeforeExit?.engine).toBe(engineId);
  expect(ledger.claims.has(id(1))).toBe(false);
  expect(source.reports).toContainEqual({ ticket: id(1), event: 'done' });
});

test('runEngine does not take a ticket whose Claim another running Engine holds', async () => {
  const ran: Ticket[] = [];
  const ledger = makeLedgerMemory();
  const source = fakeSource([sampleTicket(1), sampleTicket(2)]);
  const live = Claim.make({ ticket: id(1), engine: otherEngine, process: 2, host: 'memory' });
  ledger.running.add(2);
  ledger.claims.set(id(1), live);
  const layer = Layer.mergeAll(source.layer, HarnessSelectorNoop, capturingImplementation(ran));

  expect(await Effect.runPromise(runEngine({ project, limit: 1 }, ledger).pipe(Effect.provide(layer)))).toBeUndefined();
  expect(ran.map((ticket) => ticket.id)).toEqual([id(2)]);
  expect(ledger.claims.get(id(1))).toEqual(live);
  expect(source.reports).toEqual([{ ticket: id(2), event: 'claimed' }]);
});

test('runEngine releases only its own Claims on exit and reports each release', async () => {
  const ledger = makeLedgerMemory();
  const source = fakeSource([sampleTicket(1), sampleTicket(2), blockedTicket(3, 1)]);
  const hangingImplementation = Layer.succeed(StrategySelector, {
    select: () => Effect.succeed({ name: 'implementation', run: () => Effect.never }),
  });
  ledger.claims.set(id(2), heldByOther(id(2)));
  const layer = Layer.mergeAll(source.layer, HarnessSelectorNoop, hangingImplementation);

  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* runEngine({ project, concurrency: 1 }, ledger).pipe(
        Effect.provide(layer),
        Effect.forkChild({ startImmediately: true })
      );
      yield* until(() => ledger.claims.has(id(1)));
      yield* Fiber.interrupt(fiber);
    })
  );

  expect(ledger.claims.has(id(1))).toBe(false);
  expect([...ledger.claims.values()]).toEqual([heldByOther(id(2))]);
  expect(source.reports).toEqual([
    { ticket: id(1), event: 'claimed' },
    { ticket: id(1), event: 'released' },
  ]);
});

test('runEngine keeps a Claim in the Ledger on exit when the Source fails to report its release, and logs it', async () => {
  const ledger = makeLedgerMemory();
  const messages: string[] = [];
  const source = fakeSource([sampleTicket(1)], {
    report: (ticket, event) =>
      event === 'released' ? Effect.fail(new TicketEventNotReported({ ticketId: ticket, event })) : Effect.void,
  });
  const hangingImplementation = Layer.succeed(StrategySelector, {
    select: () => Effect.succeed({ name: 'implementation', run: () => Effect.never }),
  });
  const layer = Layer.mergeAll(
    source.layer,
    HarnessSelectorNoop,
    hangingImplementation,
    Layer.succeed(Console.Console, capturingConsole(messages))
  );

  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* runEngine({ project }, ledger).pipe(
        Effect.provide(layer),
        Effect.forkChild({ startImmediately: true })
      );
      yield* until(() => ledger.claims.has(id(1)) && source.reports.length === 1);
      yield* Fiber.interrupt(fiber);
    })
  );

  expect(ledger.claims.get(id(1))?.engine).toBe(engineId);
  expect(source.reports).toEqual([{ ticket: id(1), event: 'claimed' }]);
  expect(messages).toContainEqual(
    expect.stringContaining(`Failed to report the end of ticket ${id(1)} after the run, so its Claim stays in the Ledger`)
  );
});

test('the exit of one Engine leaves the Claim of another Engine on the same Ledger in place', async () => {
  const ledger = makeLedgerMemory();
  const source = fakeSource([sampleTicket(1), sampleTicket(2)]);
  const hangingImplementation = Layer.succeed(StrategySelector, {
    select: () => Effect.succeed({ name: 'implementation', run: () => Effect.never }),
  });
  const layer = Layer.mergeAll(source.layer, HarnessSelectorNoop, hangingImplementation);
  const engineOf = (seed: string) =>
    executeEngine({ project, limit: 1 }).pipe(
      Random.withSeed(seed),
      Effect.provide(Layer.mergeAll(EngineStartupTest, ledger.layer, layer))
    );
  const engineIdOf = (seed: string) => Effect.runSync(createEngine.pipe(Random.withSeed(seed))).id;

  expect(engineIdOf('first')).not.toBe(engineIdOf('second'));
  await Effect.runPromise(
    Effect.gen(function* () {
      const first = yield* engineOf('first').pipe(Effect.forkChild({ startImmediately: true }));
      yield* until(() => ledger.claims.size === 1);
      const second = yield* engineOf('second').pipe(Effect.forkChild({ startImmediately: true }));
      yield* until(() => ledger.claims.size === 2);
      yield* Fiber.interrupt(first);

      expect([...ledger.claims.values()].map((claim) => [claim.ticket, claim.engine])).toEqual([
        [id(2), engineIdOf('second')],
      ]);
      expect(source.reports).toEqual([
        { ticket: id(1), event: 'claimed' },
        { ticket: id(2), event: 'claimed' },
        { ticket: id(1), event: 'released' },
      ]);
      yield* Fiber.interrupt(second);
    })
  );
});

test('runEngine in a Drain ends at once when no ticket is Eligible, and says that the Engine is Idle', async () => {
  const messages: string[] = [];
  const source = fakeSource([Ticket.create({ ...sampleFields(1), hitl: 'yes' })]);
  const layer = Layer.mergeAll(
    source.layer,
    HarnessSelectorNoop,
    StrategySelectorNoop,
    Layer.succeed(Console.Console, capturingConsole(messages))
  );

  // The test clock never moves, so a run that waited for a poll would never end.
  await Effect.runPromise(runEngine({ project }).pipe(Effect.provide(Layer.mergeAll(layer, TestClock.layer()))));

  expect(messages).toContain('The Engine is Idle, so the Drain ends');
  expect(messages).not.toContain('No tickets are found, continuing');
  expect(source.reports).toEqual([]);
});

test('runEngine in a Drain ends once it has run both Eligible tickets', async () => {
  const ran: Ticket[] = [];
  const source = fakeSource([sampleTicket(1), sampleTicket(2)]);
  const layer = Layer.mergeAll(source.layer, HarnessSelectorNoop, capturingImplementation(ran));

  await Effect.runPromise(runEngine({ project }).pipe(Effect.provide(Layer.mergeAll(layer, TestClock.layer()))));

  expect(ran).toEqual([sampleTicket(1), sampleTicket(2)]);
  expect(source.doneReported).toEqual([id(1), id(2)]);
});

test('runEngine in a Drain with Ticket Processing in progress polls again as soon as it ends, and ends once Idle', async () => {
  const ran: TicketId[] = [];
  const source = fakeSource([sampleTicket(1), blockedTicket(2, 1)]);

  await Effect.runPromise(
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>();
      // Ticket 1 stays in Ticket Processing until the test releases it.
      const held = Layer.succeed(StrategySelector, {
        select: (kind) =>
          Effect.succeed({
            name: kind,
            run: (ticket) =>
              (ticket.id === id(1) ? Deferred.await(release) : Effect.void).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    ran.push(ticket.id);
                  })
                ),
                Effect.as(Result.succeed(undefined))
              ),
          }),
      });
      const fiber = yield* runEngine({ project, concurrency: 2, workspace: 'worktree' }).pipe(
        Effect.provide(Layer.mergeAll(source.layer, HarnessSelectorNoop, held)),
        Effect.forkChild({ startImmediately: true })
      );
      // The second Runner finds nothing while ticket 1 is in progress, so the Drain
      // does not end. The test clock never moves: the end of that Ticket
      // Processing, not the poll interval, wakes the poll that takes ticket 2.
      yield* until(() => source.scopeReads.length === startRead + 2);
      expect(fiber.pollUnsafe()).toBeUndefined();
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestClock.layer()))
  );

  expect(ran).toEqual([id(1), id(2)]);
});
test('runEngine in a Drain that ends with held tickets prints each one with its Ticket Status and reason', async () => {
  const messages: string[] = [];
  const ledger = makeLedgerMemory();
  ledger.escalated.set(id(3), escalationOf(id(3)));
  ledger.claims.set(id(4), heldByOther(id(4)));
  const source = fakeSource(
    [
      sampleTicket(1),
      Ticket.create({ ...sampleFields(2), hitl: 'yes' }),
      sampleTicket(3),
      sampleTicket(4),
      blockedTicket(5, 2),
    ],
    { unreadable: [UnreadableTicket.make({ name: 'README.md', reason: 'no numeric prefix' })] }
  );
  const layer = Layer.mergeAll(
    source.layer,
    HarnessSelectorNoop,
    StrategySelectorNoop,
    Layer.succeed(Console.Console, capturingConsole(messages))
  );

  await Effect.runPromise(runEngine({ project }, ledger).pipe(Effect.provide(Layer.mergeAll(layer, TestClock.layer()))));

  expect(source.doneReported).toEqual([id(1)]);
  expect(messages.slice(messages.indexOf('The Engine is Idle, so the Drain ends'))).toEqual([
    'The Engine is Idle, so the Drain ends',
    '5 tickets are held back:',
    'folder:2  Random ticket   not ready  (HITL: yes)',
    'folder:3  Random ticket   escalated  (Escalation: strategy failure, 1 attempt, Ticket Worktree /repo/.sandcastle/worktrees/ticket-folder:3)',
    `folder:4  Random ticket   claimed  (Claim: Engine ${otherEngine}, no Runner yet, process 1, host memory)`,
    'folder:5  Blocked ticket  blocked  (Blockers: open folder:2)',
    '-         README.md       unreadable  (no numeric prefix)',
  ]);
});

test('runEngine in a Drain that ends with nothing held back says so', async () => {
  const messages: string[] = [];
  const layer = Layer.mergeAll(
    fakeSource([sampleTicket(1)]).layer,
    HarnessSelectorNoop,
    StrategySelectorNoop,
    Layer.succeed(Console.Console, capturingConsole(messages))
  );

  await Effect.runPromise(runEngine({ project }).pipe(Effect.provide(Layer.mergeAll(layer, TestClock.layer()))));

  expect(messages.slice(-2)).toEqual(['The Engine is Idle, so the Drain ends', 'No tickets are held back']);
});

test('runEngine in a Drain that ends at its Limit prints no held tickets', async () => {
  const messages: string[] = [];
  const layer = Layer.mergeAll(
    fakeSource([sampleTicket(1), sampleTicket(2)]).layer,
    HarnessSelectorNoop,
    StrategySelectorNoop,
    Layer.succeed(Console.Console, capturingConsole(messages))
  );

  await Effect.runPromise(runEngine({ project, limit: 1 }).pipe(Effect.provide(Layer.mergeAll(layer, TestClock.layer()))));

  expect(messages.filter((message) => message.includes('Idle') || message.includes('held back'))).toEqual([]);
});

test('runEngine in a Watch keeps polling while Idle and takes a ticket that becomes Eligible on a later poll', async () => {
  const ran: Ticket[] = [];
  const source = fakeSource([Ticket.create({ ...sampleFields(1), hitl: 'yes' })]);
  const layer = Layer.mergeAll(source.layer, HarnessSelectorNoop, capturingImplementation(ran));

  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* runEngine({ project, watch: true }).pipe(
        Effect.provide(layer),
        Effect.forkChild({ startImmediately: true })
      );
      yield* TestClock.adjust('0 millis');
      expect(source.scopeReads.length).toBe(startRead + 1);
      yield* TestClock.adjust('10 seconds');
      yield* TestClock.adjust('10 seconds');
      expect(source.scopeReads.length).toBe(startRead + 3);
      expect(ran).toEqual([]);

      source.add(sampleTicket(1));
      yield* TestClock.adjust('10 seconds');
      expect(ran).toEqual([sampleTicket(1)]);
      expect(fiber.pollUnsafe()).toBeUndefined();
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(TestClock.layer()))
  );
});

test('runEngine in a Watch with no idle timeout keeps running while Idle', async () => {
  const messages: string[] = [];

  await Effect.runPromise(
    Effect.gen(function* () {
      const layer = Layer.mergeAll(
        fakeSource().layer,
        HarnessSelectorNoop,
        StrategySelectorNoop,
        Layer.succeed(Console.Console, capturingConsole(messages))
      );
      const fiber = yield* runEngine({ project, watch: true }).pipe(
        Effect.provide(layer),
        Effect.forkChild({ startImmediately: true })
      );

      yield* TestClock.adjust('24 hours');
      expect(fiber.pollUnsafe()).toBeUndefined();
      expect(messages.filter((message) => message.includes('Idle'))).toEqual([]);
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(TestClock.layer()))
  );
});

test('runEngine in a Watch stops the run when Idle for the given idleTimeout, and names that timeout', async () => {
  const messages: string[] = [];

  await Effect.runPromise(
    Effect.gen(function* () {
      const layer = Layer.mergeAll(
        fakeSource().layer,
        HarnessSelectorNoop,
        StrategySelectorNoop,
        Layer.succeed(Console.Console, capturingConsole(messages))
      );
      const fiber = yield* runEngine({ project, watch: true, idleTimeout: '30 seconds' }).pipe(
        Effect.provide(layer),
        Effect.forkChild({ startImmediately: true })
      );

      yield* TestClock.adjust('29 seconds');
      expect(fiber.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust('1 second');
      yield* Fiber.join(fiber);
      expect(messages).toContain('The Engine was Idle for 30s. Engine is shutting down.');
    }).pipe(Effect.provide(TestClock.layer()))
  );
});

test('runEngine stays up while a Runner is in Ticket Processing even if other polls are empty', async () => {
  const hangingImplementation = Layer.succeed(StrategySelector, {
    select: () =>
      Effect.succeed({
        name: 'implementation',
        run: () => Effect.never,
      }),
  });

  await Effect.runPromise(
    Effect.gen(function* () {
      const layer = Layer.mergeAll(
        fakeSource([sampleTicket(1)]).layer,
        HarnessSelectorNoop,
        hangingImplementation
      );
      const fiber = yield* runEngine({ project, concurrency: 2, workspace: 'worktree' }).pipe(
        Effect.provide(layer),
        Effect.forkChild({ startImmediately: true })
      );

      yield* TestClock.adjust('6 minutes');
      expect(fiber.pollUnsafe()).toBeUndefined();
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(TestClock.layer()))
  );
});

test('runEngine in a Watch starts a fresh Idle window after Ticket Processing ends', async () => {
  const ran: Ticket[] = [];
  await Effect.runPromise(
    Effect.gen(function* () {
      const layer = Layer.mergeAll(
        fakeSource([sampleTicket(1)]).layer,
        HarnessSelectorNoop,
        capturingImplementation(ran)
      );
      const fiber = yield* runEngine({ project, watch: true, idleTimeout: '5 minutes' }).pipe(
        Effect.provide(layer),
        Effect.forkChild({ startImmediately: true })
      );

      yield* until(() => ran.length === 1);
      yield* TestClock.adjust('5 minutes');
      yield* Fiber.join(fiber);
      expect(ran).toEqual([sampleTicket(1)]);
    }).pipe(Effect.provide(TestClock.layer()))
  );
});

test('runEngine in a Watch zeros the Idle clock when a Claim starts', async () => {
  const emitted: Ticket[] = [];
  const source = fakeSource();

  await Effect.runPromise(
    Effect.gen(function* () {
      const layer = Layer.mergeAll(
        source.layer,
        HarnessSelectorNoop,
        capturingImplementation(emitted)
      );
      const fiber = yield* runEngine({ project, watch: true, idleTimeout: '5 minutes' }).pipe(
        Effect.provide(layer),
        Effect.forkChild({ startImmediately: true })
      );

      yield* TestClock.adjust('239 seconds');
      source.add(sampleTicket(1));
      yield* TestClock.adjust('2 seconds');
      expect(emitted).toEqual([sampleTicket(1)]);
      yield* TestClock.adjust('4 minutes');
      expect(fiber.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust('1 minute');
      yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestClock.layer()))
  );
});

test('runEngine with Ticket Worktrees creates a missing worktrees directory under the repository root', async () => {
  const messages: string[] = [];
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({ prefix: 'engine-worktrees-' });
      const worktrees = path.join(root, '.sandcastle', 'worktrees');
      const layer = Layer.mergeAll(
        fakeSource([]).layer,
        HarnessSelectorNoop,
        StrategySelectorNoop,
        gitRootOf(root),
        makeLedgerMemory().layer,
        WorktreeManagerNoop,
        Layer.succeed(Console.Console, capturingConsole(messages))
      );

      yield* executeEngine({ limit: 0, workspace: 'worktree' }).pipe(Random.withSeed('test'), Effect.provide(layer));
      expect(yield* fs.exists(worktrees)).toBe(true);
      expect(messages).toEqual([
        `Worktrees directory is creating at ${worktrees}`,
        `Worktrees directory is ready at ${worktrees}`,
      ]);
    }).pipe(Effect.provide(NodeServices.layer))
  );
});

test('runEngine with Ticket Worktrees stops before any ticket when the worktrees directory is not writable', async () => {
  const ran: Ticket[] = [];
  const messages: string[] = [];
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({ prefix: 'engine-worktrees-' });
      const worktrees = path.join(root, '.sandcastle', 'worktrees');
      yield* fs.makeDirectory(worktrees, { recursive: true });
      yield* fs.chmod(worktrees, 0o555);
      const realPath = yield* fs.realPath(worktrees);
      const layer = Layer.mergeAll(
        fakeSource([sampleTicket(1)]).layer,
        HarnessSelectorNoop,
        capturingImplementation(ran),
        gitRootOf(root),
        makeLedgerMemory().layer,
        WorktreeManagerNoop,
        Layer.succeed(Console.Console, capturingConsole(messages))
      );

      const error = yield* executeEngine({ project, limit: 1, workspace: 'worktree' }).pipe(
        Random.withSeed('test'),
        Effect.provide(layer),
        Effect.flip
      );
      expect(ran).toEqual([]);
      expect(error.message).toBe(`chmod u+w ${realPath}`);
      expect(messages).toContain(`chmod u+w ${realPath}`);
    }).pipe(Effect.provide(NodeServices.layer))
  );
});

test('runEngine with Ticket Worktrees proceeds when the worktrees directory is writable', async () => {
  const ran: Ticket[] = [];
  const ticket = sampleTicket(1);
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({ prefix: 'engine-worktrees-' });
      yield* fs.makeDirectory(path.join(root, '.sandcastle', 'worktrees'), { recursive: true });
      const layer = Layer.mergeAll(
        fakeSource([ticket]).layer,
        HarnessSelectorNoop,
        capturingImplementation(ran),
        gitRootOf(root),
        makeLedgerMemory().layer,
        WorktreeManagerNoop
      );

      yield* executeEngine({ project, limit: 1, workspace: 'worktree' }).pipe(Random.withSeed('test'), Effect.provide(layer));
      expect(ran).toEqual([ticket]);
    }).pipe(Effect.provide(NodeServices.layer))
  );
});

test('runEngine does not claim a ticket when the Repository Root cannot be found', async () => {
  const ledger = makeLedgerMemory();
  const source = fakeSource([sampleTicket(1)]);
  const error = await Effect.runPromise(
    executeEngine({ project, limit: 1 }).pipe(
      Random.withSeed('test'),
      Effect.provide(
        Layer.mergeAll(
          source.layer,
          ledger.layer,
          HarnessSelectorNoop,
          StrategySelectorNoop,
          WorktreeManagerNoop,
          Path.layer,
          FileSystem.layerNoop({
            exists: () => Effect.succeed(true),
            access: () => Effect.void,
          }),
          Layer.effect(RepositoryRoot, Effect.fail(new RepositoryRootNotFound()))
        )
      ),
      Effect.flip
    )
  );
  expect(error).toBeInstanceOf(RepositoryRootNotFound);
  expect(ledger.claims.size).toBe(0);
  expect(source.reports).toEqual([]);
});

// A Worktree Manager whose check runs answer in turn from `runs`, each recorded in
// the timeline with its command, worktree, and time limit; the merge is recorded too.
// With `states`, each question whether a worktree is clean answers in turn from
// them and is recorded; without, every worktree is clean.
const checkingWorktrees = (timeline: string[], runs: readonly CommandRun[], states?: readonly boolean[]) => {
  const pending = [...runs];
  const pendingStates = states === undefined ? undefined : [...states];
  return Layer.succeed(WorktreeManager, {
    prepareProject: (value) => Effect.succeed({ path: `/repo/.sandcastle/worktrees/${value}`, branch: value }),
    prepareTicket: ({ id: ticket }) =>
      Effect.succeed({ path: `/repo/.sandcastle/worktrees/ticket-${ticket}`, branch: `ticket-${ticket}` }),
    runCommand: ({ worktree, command, timeLimit }) =>
      Effect.sync(() => {
        timeline.push(`check \`${command}\` in ${worktree.path} within ${Duration.format(Duration.fromInputUnsafe(timeLimit))}`);
        const run = pending.shift();
        if (run === undefined) {
          throw new Error('no check run left');
        }
        return run;
      }),
    changedPaths: (worktree) =>
      Effect.sync(() => {
        if (pendingStates === undefined) {
          return [];
        }
        const clean = pendingStates.shift();
        if (clean === undefined) {
          throw new Error('no worktree state left');
        }
        timeline.push(`${worktree.path} is ${clean ? 'clean' : 'dirty'}`);
        return clean ? [] : ['work.txt'];
      }),
    mergeAndClose: () =>
      Effect.sync(() => {
        timeline.push('merge and close');
      }),
  });
};

// A Harness that records in the timeline each prompt it receives, with its directory,
// and the model demand of each run.
const recordingHarness = (timeline: string[], prompts: string[], demands: Array<ModelDemand | undefined> = []) =>
  Layer.succeed(HarnessSelector, {
    select: Effect.succeed({
      name: 'default',
      model: 'default-model',
      run: (prompt, options) =>
        Effect.sync(() => {
          timeline.push(`harness ${options.label} in ${options.cwd}`);
          prompts.push(prompt);
          demands.push(options.model);
          return { completionSignal: undefined };
        }),
    } satisfies Harness),
  });

const passed: CommandRun = { _tag: 'Exited', exitCode: 0, output: 'all green\n' };
const failed = (output = 'error TS2322\n'): CommandRun => ({ _tag: 'Exited', exitCode: 1, output });

const checkOf = (fields: Partial<CheckConfig> = {}): CheckConfig => ({
  ...defaultCheckConfig,
  command: 'pnpm typecheck && pnpm test',
  ...fields,
});

const worktreeOf = (ticket: TicketId) => `/repo/.sandcastle/worktrees/ticket-${ticket}`;

// The one Harness run of the Strategy, before any check.
const strategyRun = (ticket: TicketId) => `harness ticket-${ticket} in ${worktreeOf(ticket)}`;

const runChecked = (
  check: CheckConfig | undefined,
  runs: readonly CommandRun[],
  tickets: readonly Ticket[] = [sampleTicket(1)],
  messages: string[] = []
) => {
  const timeline: string[] = [];
  const prompts: string[] = [];
  const ledger = makeLedgerMemory();
  const source = fakeSource(tickets);
  const layer = Layer.mergeAll(
    EngineStartupTest,
    checkingWorktrees(timeline, runs),
    ledger.layer,
    source.layer,
    recordingHarness(timeline, prompts),
    StrategySelectorNoop,
    Layer.succeed(Console.Console, capturingConsole(messages))
  );
  const result = Effect.runPromise(
    executeEngine({ project, limit: tickets.length, check }).pipe(
      Random.withSeed('test'),
      Effect.provide(layer),
      Effect.result
    )
  );
  return result.then((outcome) => ({ outcome, timeline, prompts, ledger, source }));
};

test('runEngine runs the check command in the Ticket Worktree after the Strategy, and merges when it passes', async () => {
  const { outcome, timeline, ledger } = await runChecked(checkOf(), [passed]);

  expect(Result.isSuccess(outcome)).toBe(true);
  expect(timeline).toEqual([
    strategyRun(id(1)),
    `check \`pnpm typecheck && pnpm test\` in ${worktreeOf(id(1))} within 10m`,
    'merge and close',
  ]);
  expect(ledger.done.has(id(1))).toBe(true);
});

test('runEngine sends the fix prompt with the check output to the Harness in the same Ticket Worktree, checks again, and merges once it passes', async () => {
  const output = Array.from({ length: 250 }, (_, line) => `line ${line + 1}`).join('\n');
  const { outcome, timeline, prompts, ledger } = await runChecked(checkOf(), [failed(output), passed]);

  expect(Result.isSuccess(outcome)).toBe(true);
  expect(timeline).toEqual([
    strategyRun(id(1)),
    `check \`pnpm typecheck && pnpm test\` in ${worktreeOf(id(1))} within 10m`,
    `harness ticket-${id(1)}-fix-1 in ${worktreeOf(id(1))}`,
    `check \`pnpm typecheck && pnpm test\` in ${worktreeOf(id(1))} within 10m`,
    'merge and close',
  ]);
  const [, prompt] = prompts;
  expect(prompt).toContain(defaultFixPrompt);
  expect(prompt).toContain('`pnpm typecheck && pnpm test`');
  expect(prompt).toContain('It exited with code 1.');
  expect(prompt).toContain('line 51\n');
  expect(prompt).toContain('line 250');
  expect(prompt).not.toContain('line 50\n');
  expect(ledger.done.has(id(1))).toBe(true);
});

test('runEngine escalates and halts with no merge when the check still fails after the fix attempts', async () => {
  const { outcome, timeline, ledger, source } = await runChecked(checkOf({ fixAttempts: 2 }), [
    failed(),
    failed(),
    failed(),
  ]);

  expect(outcome).toEqual(Result.fail(new EngineHalted({ ticketId: id(1), reason: 'check failure' })));
  expect(timeline).toEqual([
    strategyRun(id(1)),
    `check \`pnpm typecheck && pnpm test\` in ${worktreeOf(id(1))} within 10m`,
    `harness ticket-${id(1)}-fix-1 in ${worktreeOf(id(1))}`,
    `check \`pnpm typecheck && pnpm test\` in ${worktreeOf(id(1))} within 10m`,
    `harness ticket-${id(1)}-fix-2 in ${worktreeOf(id(1))}`,
    `check \`pnpm typecheck && pnpm test\` in ${worktreeOf(id(1))} within 10m`,
  ]);
  expect([...ledger.escalated.values()]).toEqual([
    Escalation.make({ ticket: id(1), reason: 'check failure', attempts: 1, worktree: worktreeOf(id(1)) }),
  ]);
  expect(ledger.done.size).toBe(0);
  expect(source.doneReported).toEqual([]);
  expect(source.reports).toEqual([
    { ticket: id(1), event: 'claimed' },
    { ticket: id(1), event: 'escalated' },
  ]);
});

test('runEngine escalates with no fix prompt when a check fails with no fix attempts', async () => {
  const { outcome, timeline } = await runChecked(checkOf({ fixAttempts: 0 }), [failed()]);

  expect(outcome).toEqual(Result.fail(new EngineHalted({ ticketId: id(1), reason: 'check failure' })));
  expect(timeline).toEqual([strategyRun(id(1)), `check \`pnpm typecheck && pnpm test\` in ${worktreeOf(id(1))} within 10m`]);
});

test('runEngine counts a check ended by its time limit as a failed check', async () => {
  const timedOut: CommandRun = { _tag: 'TimedOut', output: 'still running\n' };
  const { outcome, timeline, prompts } = await runChecked(checkOf({ timeLimit: Duration.minutes(2) }), [
    timedOut,
    timedOut,
  ]);

  expect(outcome).toEqual(Result.fail(new EngineHalted({ ticketId: id(1), reason: 'check failure' })));
  expect(timeline).toEqual([
    strategyRun(id(1)),
    `check \`pnpm typecheck && pnpm test\` in ${worktreeOf(id(1))} within 2m`,
    `harness ticket-${id(1)}-fix-1 in ${worktreeOf(id(1))}`,
    `check \`pnpm typecheck && pnpm test\` in ${worktreeOf(id(1))} within 2m`,
  ]);
  expect(prompts[1]).toContain('Its time limit of 2m ended it.');
  expect(prompts[1]).toContain('still running');
});

test('runEngine sends the configured fix prompt', async () => {
  const { prompts } = await runChecked(checkOf({ fixPrompt: 'Run /fix-check on this output.' }), [failed(), passed]);

  expect(prompts[1]?.startsWith('Run /fix-check on this output.')).toBe(true);
});

test('runEngine skips the check and logs it when no check command is configured, then merges', async () => {
  const messages: string[] = [];
  const { outcome, timeline, ledger } = await runChecked(defaultCheckConfig, [], [sampleTicket(1)], messages);

  expect(Result.isSuccess(outcome)).toBe(true);
  expect(timeline).toEqual([strategyRun(id(1)), 'merge and close']);
  expect(messages).toContain(`${sampleTicket(1).label} has no check command configured, so the check is skipped`);
  expect(ledger.done.has(id(1))).toBe(true);
});

test('runEngine runs the check command of the ticket Project, and the default command for another Project or none', async () => {
  const other = Ticket.create({ ...sampleFields(2), project: 'other-app' });
  const loose = Ticket.create({ ...sampleFields(3), project: undefined });
  const check = checkOf({ command: 'pnpm check', projects: { [project]: 'pnpm --filter app check' } });
  const timeline: string[] = [];
  const ledger = makeLedgerMemory();
  const layer = Layer.mergeAll(
    EngineStartupTest,
    checkingWorktrees(timeline, [passed, passed, passed]),
    ledger.layer,
    fakeSource([sampleTicket(1), other, loose]).layer,
    HarnessSelectorNoop,
    StrategySelectorNoop
  );

  await Effect.runPromise(
    executeEngine({ limit: 3, check }).pipe(Random.withSeed('test'), Effect.provide(layer))
  );

  expect(timeline.filter((entry) => entry.startsWith('check'))).toEqual([
    `check \`pnpm --filter app check\` in ${worktreeOf(id(1))} within 10m`,
    `check \`pnpm check\` in ${worktreeOf(id(2))} within 10m`,
    `check \`pnpm check\` in ${worktreeOf(id(3))} within 10m`,
  ]);
});

test('runEngine skips the check of a ticket whose Project has no override when no default command is configured', async () => {
  const other = Ticket.create({ ...sampleFields(2), project: 'other-app' });
  const check: CheckConfig = { ...defaultCheckConfig, projects: { [project]: 'pnpm --filter app check' } };
  const timeline: string[] = [];
  const layer = Layer.mergeAll(
    EngineStartupTest,
    checkingWorktrees(timeline, [passed]),
    makeLedgerMemory().layer,
    fakeSource([sampleTicket(1), other]).layer,
    HarnessSelectorNoop,
    StrategySelectorNoop
  );

  await Effect.runPromise(
    executeEngine({ limit: 2, check }).pipe(Random.withSeed('test'), Effect.provide(layer))
  );

  expect(timeline).toEqual([
    `check \`pnpm --filter app check\` in ${worktreeOf(id(1))} within 10m`,
    'merge and close',
    'merge and close',
  ]);
});

test('runEngine does not run the check when the Strategy fails', async () => {
  const timeline: string[] = [];
  const layer = Layer.mergeAll(
    EngineStartupTest,
    checkingWorktrees(timeline, []),
    makeLedgerMemory().layer,
    fakeSource([sampleTicket(1)]).layer,
    HarnessSelectorNoop,
    failingStrategy
  );

  const error = await Effect.runPromise(
    executeEngine({ project, check: checkOf() }).pipe(Random.withSeed('test'), Effect.provide(layer), Effect.flip)
  );

  expect(error).toEqual(new EngineHalted({ ticketId: id(1), reason: 'strategy failure: step 1, Harness error' }));
  expect(timeline).toEqual([]);
});

// Runs the Engine with Ticket Worktrees on one ticket with the given check and
// commit config, the check runs in `runs`, and the worktree states in `states`.
const runCommitted = ({
  check = defaultCheckConfig,
  commit,
  runs = [],
  states,
}: {
  readonly check?: CheckConfig;
  readonly commit?: CommitConfig;
  readonly runs?: readonly CommandRun[];
  readonly states: readonly boolean[];
}) => {
  const timeline: string[] = [];
  const prompts: string[] = [];
  const demands: Array<ModelDemand | undefined> = [];
  const ledger = makeLedgerMemory();
  const source = fakeSource([sampleTicket(1)]);
  const layer = Layer.mergeAll(
    EngineStartupTest,
    checkingWorktrees(timeline, runs, states),
    ledger.layer,
    source.layer,
    recordingHarness(timeline, prompts, demands),
    StrategySelectorNoop
  );
  return Effect.runPromise(
    executeEngine({ project, limit: 1, check, commit, workspace: 'worktree' }).pipe(Random.withSeed('test'), Effect.provide(layer), Effect.result)
  ).then((outcome) => ({ outcome, timeline, prompts, demands, ledger, source }));
};

test('runEngine sends no commit prompt when the Ticket Worktree is clean, and merges', async () => {
  const { outcome, timeline, prompts, ledger } = await runCommitted({ check: checkOf(), runs: [passed], states: [true] });

  expect(Result.isSuccess(outcome)).toBe(true);
  expect(timeline).toEqual([
    strategyRun(id(1)),
    `check \`pnpm typecheck && pnpm test\` in ${worktreeOf(id(1))} within 10m`,
    `${worktreeOf(id(1))} is clean`,
    'merge and close',
  ]);
  expect(prompts).toHaveLength(1);
  expect(ledger.done.has(id(1))).toBe(true);
});

test('runEngine sends the rendered commit prompt with its model demand when the Ticket Worktree is dirty, and merges once it is clean', async () => {
  const commit: CommitConfig = { prompt: '/commit {{project}} ticket-{{id}}: {{title}}', model: { tier: 'mid' } };
  const { outcome, timeline, prompts, demands, ledger } = await runCommitted({ commit, states: [false, true] });

  expect(Result.isSuccess(outcome)).toBe(true);
  expect(timeline).toEqual([
    strategyRun(id(1)),
    `${worktreeOf(id(1))} is dirty`,
    `harness ticket-${id(1)}-commit in ${worktreeOf(id(1))}`,
    `${worktreeOf(id(1))} is clean`,
    'merge and close',
  ]);
  expect(prompts[1]).toBe(`/commit ${project} ticket-${id(1)}: ${sampleTicket(1).title}`);
  expect(demands[1]).toEqual({ tier: 'mid' });
  expect(ledger.done.has(id(1))).toBe(true);
});

test('runEngine sends the default commit prompt on a fast low-tier model unless one is configured', async () => {
  const { prompts, demands } = await runCommitted({ states: [false, true] });

  expect(prompts[1]).toBe(renderPrompt(defaultCommitPrompt, sampleTicket(1)));
  expect(prompts[1]).toContain(id(1));
  expect(demands[1]).toEqual(defaultCommitConfig.model);
});

test('runEngine escalates and halts with no merge and no fix prompt when the Ticket Worktree stays dirty', async () => {
  const { outcome, timeline, ledger, source } = await runCommitted({ check: checkOf(), runs: [passed], states: [false, false] });

  expect(outcome).toEqual(Result.fail(new EngineHalted({ ticketId: id(1), reason: 'commit failure' })));
  expect(timeline).toEqual([
    strategyRun(id(1)),
    `check \`pnpm typecheck && pnpm test\` in ${worktreeOf(id(1))} within 10m`,
    `${worktreeOf(id(1))} is dirty`,
    `harness ticket-${id(1)}-commit in ${worktreeOf(id(1))}`,
    `${worktreeOf(id(1))} is dirty`,
  ]);
  expect([...ledger.escalated.values()]).toEqual([
    Escalation.make({ ticket: id(1), reason: 'commit failure', attempts: 1, worktree: worktreeOf(id(1)) }),
  ]);
  expect(ledger.done.size).toBe(0);
  expect(source.doneReported).toEqual([]);
  expect(source.reports).toEqual([
    { ticket: id(1), event: 'claimed' },
    { ticket: id(1), event: 'escalated' },
  ]);
});

test('runEngine asks whether the Ticket Worktree is clean after the check command and its fix attempts', async () => {
  const { outcome, timeline } = await runCommitted({ check: checkOf(), runs: [failed(), passed], states: [false, true] });

  expect(Result.isSuccess(outcome)).toBe(true);
  expect(timeline).toEqual([
    strategyRun(id(1)),
    `check \`pnpm typecheck && pnpm test\` in ${worktreeOf(id(1))} within 10m`,
    `harness ticket-${id(1)}-fix-1 in ${worktreeOf(id(1))}`,
    `check \`pnpm typecheck && pnpm test\` in ${worktreeOf(id(1))} within 10m`,
    `${worktreeOf(id(1))} is dirty`,
    `harness ticket-${id(1)}-commit in ${worktreeOf(id(1))}`,
    `${worktreeOf(id(1))} is clean`,
    'merge and close',
  ]);
});

test('runEngine does not ask whether the Ticket Worktree is clean when the check fails', async () => {
  const { outcome, timeline } = await runCommitted({ check: checkOf({ fixAttempts: 0 }), runs: [failed()], states: [] });

  expect(outcome).toEqual(Result.fail(new EngineHalted({ ticketId: id(1), reason: 'check failure' })));
  expect(timeline).toEqual([strategyRun(id(1)), `check \`pnpm typecheck && pnpm test\` in ${worktreeOf(id(1))} within 10m`]);
});

// Runs the Engine with Ticket Worktrees on one ticket whose Strategy succeeds, with
// the given Worktree Manager and Harness, and no check command.
const runWith = (worktrees: Layer.Layer<WorktreeManager>, harness: Layer.Layer<HarnessSelector>) => {
  const ledger = makeLedgerMemory();
  const layer = Layer.mergeAll(
    EngineStartupTest,
    worktrees,
    ledger.layer,
    fakeSource([sampleTicket(1)]).layer,
    harness,
    StrategySelectorNoop
  );
  return Effect.runPromise(
    executeEngine({ project, limit: 1, workspace: 'worktree' }).pipe(
      Random.withSeed('test'),
      Effect.provide(layer),
      Effect.result
    )
  ).then((outcome) => ({ outcome, ledger }));
};

test('runEngine escalates with no merge when the Harness fails on the commit prompt', async () => {
  const timeline: string[] = [];
  const failingCommit = Layer.succeed(HarnessSelector, {
    select: Effect.succeed({
      name: 'default',
      model: 'default-model',
      run: (_prompt, options) =>
        options.label.endsWith('-commit')
          ? Effect.fail(new HarnessRuntimeError())
          : Effect.succeed({ completionSignal: undefined }),
    } satisfies Harness),
  });

  const { outcome, ledger } = await runWith(checkingWorktrees(timeline, [], [false]), failingCommit);

  expect(outcome).toEqual(Result.fail(new EngineHalted({ ticketId: id(1), reason: 'commit failure' })));
  expect(timeline).toEqual([`${worktreeOf(id(1))} is dirty`]);
  expect(ledger.done.size).toBe(0);
});

test('runEngine escalates with no merge when it cannot read whether the Ticket Worktree is clean', async () => {
  const merged: string[] = [];
  const unreadable = Layer.succeed(WorktreeManager, {
    prepareProject: (value) => Effect.succeed({ path: `/repo/.sandcastle/worktrees/${value}`, branch: value }),
    prepareTicket: ({ id: ticket }) => Effect.succeed({ path: worktreeOf(ticket), branch: `ticket-${ticket}` }),
    runCommand: () => Effect.die('runCommand should not be called'),
    changedPaths: () => Effect.fail(new WorktreeCommandError()),
    mergeAndClose: (worktree) =>
      Effect.sync(() => {
        merged.push(worktree.path);
      }),
  });

  const { outcome, ledger } = await runWith(unreadable, HarnessSelectorNoop);

  expect(outcome).toEqual(Result.fail(new EngineHalted({ ticketId: id(1), reason: 'commit failure' })));
  expect(merged).toEqual([]);
  expect(ledger.done.size).toBe(0);
});

// The in-place Workspace. The Engine runs with the in-place Worktree Manager and the
// folder Source against a temporary Git repository on the branch `trunk`, whose
// queue Git tracks and whose `*.log` files Git ignores.

test('runEngine in place fails at start with a Concurrency above one, and claims nothing', () => {
  const ledger = makeLedgerMemory();
  const source = fakeSource([sampleTicket(1), sampleTicket(2)]);
  const layer = Layer.mergeAll(source.layer, HarnessSelectorNoop, StrategySelectorNoop);

  const error = Effect.runSync(runEngine({ project, concurrency: 2 }, ledger).pipe(Effect.provide(layer), Effect.flip));

  expect(error).toEqual(new ConcurrencyNotInPlace({ concurrency: 2 }));
  expect(error.message).toBe(
    'The in-place Workspace allows a Concurrency of one, and the Concurrency is 2: every Runner would share the Repository Root. ' +
      'Set `workspace: worktree` in the config to run Tickets in parallel in Ticket Worktrees, or run with `--concurrency 1`.'
  );
  expect(source.reports).toEqual([]);
  expect(ledger.claims.size).toBe(0);
});

type InPlaceServices = FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner;

// A repository with the given ticket files in its queue, all committed.
const inPlaceRepository = (tickets: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.realPath(yield* fs.makeTempDirectory({ prefix: 'engine-in-place-' }));
    const ticketsDir = path.join(root, '.agents', 'tickets');
    yield* gitIn(root, ['init', '-b', 'trunk']);
    yield* gitIn(root, ['config', 'user.email', 'test@test.com']);
    yield* gitIn(root, ['config', 'user.name', 'Test']);
    for (const [file, text] of Object.entries(tickets)) {
      yield* fs.makeDirectory(path.dirname(path.join(ticketsDir, file)), { recursive: true });
      yield* fs.writeFileString(path.join(ticketsDir, file), text);
    }
    yield* fs.writeFileString(path.join(root, '.gitignore'), '*.log\n');
    yield* fs.writeFileString(path.join(root, 'base.txt'), 'from trunk\n');
    yield* gitIn(root, ['add', '-A']);
    yield* gitIn(root, ['commit', '-m', 'init']);
    return { root, ticketsDir };
  });

// The Engine in place on the repository, with the given Harness and Strategies.
const inPlaceLayer = (
  repository: { readonly root: string; readonly ticketsDir: string },
  ledger: ReturnType<typeof makeLedgerMemory>,
  harness: Harness,
  strategies: Layer.Layer<StrategySelector> = StrategySelectorNoop,
  messages: string[] = []
) =>
  Layer.mergeAll(
    TicketSourceFolderLive.pipe(
      Layer.provide(
        Layer.merge(
          ConfigProvider.layer(ConfigProvider.fromUnknown({ ticketsDir: repository.ticketsDir })),
          gitRootOf(repository.root)
        )
      )
    ),
    WorktreeManagerInPlaceLive(repository.root, repository.ticketsDir),
    gitRootOf(repository.root),
    ledger.layer,
    Layer.succeed(HarnessSelector, { select: Effect.succeed(harness) }),
    strategies,
    Layer.succeed(Console.Console, capturingConsole(messages))
  );

// A Harness whose Agent writes the work in its directory and commits it.
const committingHarness: Harness = {
  name: 'committing',
  model: 'test-model',
  run: (_prompt, options) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.writeFileString(path.join(options.cwd!, `${options.label.replace(/[^A-Za-z0-9-]/g, '-')}.txt`), 'the work\n');
      yield* gitIn(options.cwd!, ['add', '-A']);
      yield* gitIn(options.cwd!, ['commit', '-m', `feat: ${options.label}`]);
      return { completionSignal: undefined };
    }).pipe(Effect.provide(NodeServices.layer), Effect.orDie),
};

const runInPlace = <A, E>(effect: Effect.Effect<A, E, InPlaceServices>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)));

test('runEngine in place lands the work and the done move on the current branch, with no merge and no worktree, and records done', async () => {
  const ledger = makeLedgerMemory();
  const result = await runInPlace(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repository = yield* inPlaceRepository({ '01-first.md': standardTemplate('01', 'First', 'None') });
      const { root, ticketsDir } = repository;
      yield* executeEngine({ limit: 1 }).pipe(
        Random.withSeed('test'),
        Effect.provide(inPlaceLayer(repository, ledger, committingHarness))
      );
      return {
        subjects: (yield* gitIn(root, ['log', '--format=%s'])).trim().split('\n'),
        merges: (yield* gitIn(root, ['log', '--merges', '--format=%s'])).trim(),
        branches: (yield* gitIn(root, ['branch', '--format=%(refname:short)'])).trim(),
        worktrees: (yield* gitIn(root, ['worktree', 'list', '--porcelain'])).trim().split('\n')[0],
        status: (yield* gitIn(root, ['status', '--porcelain', '--untracked-files=all'])).trim(),
        sandcastle: yield* fs.exists(path.join(root, '.sandcastle')),
        open: yield* fs.exists(path.join(ticketsDir, '01-first.md')),
        done: yield* fs.exists(path.join(ticketsDir, 'done', '01-first.md')),
        root,
      };
    })
  );

  expect(result.subjects).toEqual([doneMoveMessage(id(1)), 'feat: ticket-folder:1', 'init']);
  expect(result.merges).toBe('');
  expect(result.branches).toBe('trunk');
  expect(result.worktrees).toBe(`worktree ${result.root}`);
  expect(result.status).toBe('');
  expect(result.sandcastle).toBe(false);
  expect(result.open).toBe(false);
  expect(result.done).toBe(true);
  expect([...ledger.done]).toEqual([id(1)]);
  expect(ledger.escalated.size).toBe(0);
  expect(ledger.claims.size).toBe(0);
});

test('runEngine in place escalates a failed ticket with no worktree path, and a Retry leaves the tree as it is', async () => {
  const ledger = makeLedgerMemory();
  const messages: string[] = [];
  // The Agent leaves half the work uncommitted, and the Strategy fails.
  const halfDone: Harness = {
    name: 'half-done',
    model: 'test-model',
    run: (_prompt, options) =>
      FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) => fs.writeFileString(`${options.cwd!}/half-done.txt`, 'half the work\n')),
        Effect.as({ completionSignal: undefined }),
        Effect.provide(NodeServices.layer),
        Effect.orDie
      ),
  };
  const failingAfterHarness = Layer.succeed(StrategySelector, {
    select: () =>
      Effect.succeed({
        name: 'implementation',
        run: (ticket: Ticket, harness: Harness) =>
          harness
            .run(ticket.body, { label: `ticket-${ticket.id}` })
            .pipe(Effect.orDie, Effect.as(Result.fail(new StrategyRuntimeError({ step: 1, failure: 'Harness error' })))),
      }),
  });
  const result = await runInPlace(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repository = yield* inPlaceRepository({ '01-first.md': standardTemplate('01', 'First', 'None') });
      const { root, ticketsDir } = repository;
      const layer = inPlaceLayer(repository, ledger, halfDone, failingAfterHarness, messages);
      const halt = yield* executeEngine({ limit: 1 }).pipe(Random.withSeed('test'), Effect.provide(layer), Effect.flip);
      const escalation = ledger.escalated.get(id(1));
      const statusAfterRun = (yield* gitIn(root, ['status', '--porcelain', '--untracked-files=all'])).trim();
      yield* retryTicket({ ticket: id(1) }).pipe(Effect.provide(layer));
      return {
        halt,
        escalation,
        statusAfterRun,
        statusAfterRetry: (yield* gitIn(root, ['status', '--porcelain', '--untracked-files=all'])).trim(),
        halfDone: yield* fs.readFileString(path.join(root, 'half-done.txt')),
        open: yield* fs.exists(path.join(ticketsDir, '01-first.md')),
        subjects: (yield* gitIn(root, ['log', '--format=%s'])).trim(),
        root,
      };
    })
  );

  expect(result.halt).toEqual(new EngineHalted({ ticketId: id(1), reason: 'strategy failure: step 1, Harness error' }));
  expect(result.escalation).toEqual(
    Escalation.make({ ticket: id(1), reason: 'strategy failure: step 1, Harness error', attempts: 1 })
  );
  expect(result.escalation?.worktree).toBeUndefined();
  expect(messages).toContain(
    `Ticket folder:1 -- implementation failed (strategy failure: step 1, Harness error) and is escalated after 1 attempt(s); its work stays at ${result.root} as it is`
  );
  expect(messages).toContain(
    'folder:1 is retried after 1 attempt; the next Engine run continues in the Repository Root as it is'
  );
  expect(result.statusAfterRun).toBe('?? half-done.txt');
  expect(result.statusAfterRetry).toBe(result.statusAfterRun);
  expect(result.halfDone).toBe('half the work\n');
  expect(result.open).toBe(true);
  expect(result.subjects).toBe('init');
  expect(ledger.escalated.has(id(1))).toBe(false);
  expect(ledger.done.size).toBe(0);
});

test('runEngine in place scopes the run to a Project and runs the check command of that Project, on the current branch', async () => {
  const ledger = makeLedgerMemory();
  const auth = Schema.decodeSync(Project)('auth');
  const check = checkOf({
    command: 'echo default >> check.log',
    projects: { [auth]: 'echo auth >> check.log' },
  });
  const result = await runInPlace(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repository = yield* inPlaceRepository({
        '01-root.md': standardTemplate('01', 'Root', 'None'),
        'auth/01-login.md': standardTemplate('01', 'Login', 'None'),
        'billing/01-invoice.md': standardTemplate('01', 'Invoice', 'None'),
      });
      const { root, ticketsDir } = repository;
      yield* executeEngine({ project: auth, limit: 1, check }).pipe(
        Random.withSeed('test'),
        Effect.provide(inPlaceLayer(repository, ledger, committingHarness))
      );
      return {
        checked: yield* fs.readFileString(path.join(root, 'check.log')),
        branches: (yield* gitIn(root, ['branch', '--format=%(refname:short)'])).trim(),
        subjects: (yield* gitIn(root, ['log', '--format=%s'])).trim().split('\n'),
        sandcastle: yield* fs.exists(path.join(root, '.sandcastle')),
        open: {
          root: yield* fs.exists(path.join(ticketsDir, '01-root.md')),
          login: yield* fs.exists(path.join(ticketsDir, 'auth', '01-login.md')),
          invoice: yield* fs.exists(path.join(ticketsDir, 'billing', '01-invoice.md')),
        },
      };
    })
  );

  const login = formatTicketId('folder', 'auth/1');
  expect(result.checked).toBe('auth\n');
  expect(result.branches).toBe('trunk');
  expect(result.subjects).toEqual([doneMoveMessage(login), `feat: ticket-${login}`, 'init']);
  expect(result.sandcastle).toBe(false);
  expect(result.open).toEqual({ root: true, login: false, invoice: true });
  expect([...ledger.done]).toEqual([login]);
});

// The clean Repository Root before each ticket in place.

// A Harness that records each run and commits its work, as `committingHarness` does.
const recordingCommits = (labels: string[]): Harness => ({
  ...committingHarness,
  run: (prompt, options) =>
    Effect.sync(() => {
      labels.push(options.label);
    }).pipe(Effect.andThen(committingHarness.run(prompt, options))),
});

// Waits on the real clock until `isReady` holds.
const eventually = (isReady: () => boolean) =>
  Effect.gen(function* () {
    while (!isReady()) {
      yield* Effect.sleep('5 millis');
    }
  });

test('runEngine in a Drain in place halts before it claims a ticket when the Repository Root is dirty, and names the changed paths', async () => {
  const ledger = makeLedgerMemory();
  const labels: string[] = [];
  const result = await runInPlace(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repository = yield* inPlaceRepository({ '01-first.md': standardTemplate('01', 'First', 'None') });
      const { root, ticketsDir } = repository;
      yield* fs.writeFileString(path.join(root, 'base.txt'), 'edited by hand\n');
      yield* fs.writeFileString(path.join(root, 'notes.txt'), 'left by hand\n');
      const halt = yield* executeEngine({}).pipe(
        Random.withSeed('test'),
        Effect.provide(inPlaceLayer(repository, ledger, recordingCommits(labels))),
        Effect.flip
      );
      return {
        halt,
        root,
        subjects: (yield* gitIn(root, ['log', '--format=%s'])).trim(),
        open: yield* fs.exists(path.join(ticketsDir, '01-first.md')),
      };
    })
  );

  expect(result.halt).toEqual(new RepositoryRootDirty({ root: result.root, paths: ['base.txt', 'notes.txt'] }));
  expect(result.halt.message).toBe(
    `The Repository Root ${result.root} has uncommitted changes, which an Agent working in place would commit:\n` +
      '  base.txt\n' +
      '  notes.txt\n' +
      'Commit or stash them before the next ticket.'
  );
  expect(labels).toEqual([]);
  expect(result.subjects).toBe('init');
  expect(result.open).toBe(true);
  expect(ledger.claims.size).toBe(0);
  expect(ledger.done.size).toBe(0);
  expect(ledger.escalated.size).toBe(0);
});

test('runEngine in a Watch in place takes no ticket while the Repository Root is dirty, and takes it on a later poll once it is clean', async () => {
  const ledger = makeLedgerMemory();
  const messages: string[] = [];
  const labels: string[] = [];
  const result = await runInPlace(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repository = yield* inPlaceRepository({ '01-first.md': standardTemplate('01', 'First', 'None') });
      const { root, ticketsDir } = repository;
      const notes = path.join(root, 'notes.txt');
      yield* fs.writeFileString(notes, 'left by hand\n');
      const fiber = yield* executeEngine({ watch: true, limit: 1, pollInterval: '10 millis' }).pipe(
        Random.withSeed('test'),
        Effect.provide(inPlaceLayer(repository, ledger, recordingCommits(labels), StrategySelectorNoop, messages)),
        Effect.forkChild({ startImmediately: true })
      );
      const skippedPoll = (message: string) => message.endsWith('The Watch takes no ticket until the next poll');
      // Two skipped polls: the Watch did not fail at the first one.
      yield* eventually(() => messages.filter(skippedPoll).length >= 2);
      const whileDirty = { labels: [...labels], claims: ledger.claims.size, running: fiber.pollUnsafe() === undefined };
      yield* fs.remove(notes);
      yield* Fiber.join(fiber);
      return {
        whileDirty,
        skipped: messages.find(skippedPoll),
        root,
        subjects: (yield* gitIn(root, ['log', '--format=%s'])).trim().split('\n'),
        done: yield* fs.exists(path.join(ticketsDir, 'done', '01-first.md')),
      };
    })
  );

  expect(result.whileDirty).toEqual({ labels: [], claims: 0, running: true });
  expect(result.skipped).toBe(
    `The Repository Root ${result.root} has uncommitted changes, which an Agent working in place would commit:\n` +
      '  notes.txt\n' +
      'Commit or stash them before the next ticket.\n' +
      'The Watch takes no ticket until the next poll'
  );
  expect(labels).toEqual([`ticket-${id(1)}`]);
  expect(result.subjects).toEqual([doneMoveMessage(id(1)), `feat: ticket-${id(1)}`, 'init']);
  expect(result.done).toBe(true);
  expect([...ledger.done]).toEqual([id(1)]);
});

test('runEngine in place does not count untracked files under the tickets folder as changes', async () => {
  const ledger = makeLedgerMemory();
  const result = await runInPlace(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repository = yield* inPlaceRepository({ '01-first.md': standardTemplate('01', 'First', 'None') });
      const { ticketsDir } = repository;
      yield* fs.makeDirectory(path.join(ticketsDir, 'auth'));
      yield* fs.writeFileString(path.join(ticketsDir, 'auth', '01-login.md'), standardTemplate('01', 'Login', 'None'));
      yield* executeEngine({ limit: 1 }).pipe(
        Random.withSeed('test'),
        Effect.provide(inPlaceLayer(repository, ledger, committingHarness))
      );
      return { done: yield* fs.exists(path.join(ticketsDir, 'done', '01-first.md')) };
    })
  );

  expect(result.done).toBe(true);
  expect([...ledger.done]).toEqual([id(1)]);
});

test('runEngine with Ticket Worktrees runs while the Repository Root is dirty, and never reads its changes', async () => {
  const asked: string[] = [];
  const ran: Ticket[] = [];
  const dirtyRoot = Layer.succeed(WorktreeManager, {
    prepareProject: (value) => Effect.succeed({ path: `/repo/.sandcastle/worktrees/${value}`, branch: value }),
    prepareTicket: ({ id: ticket }) => Effect.succeed(ticketWorktreeOf(ticket)),
    runCommand: () => Effect.die('runCommand should not be called'),
    changedPaths: (worktree) =>
      Effect.sync(() => {
        asked.push(worktree.path);
        return worktree.path === '/repo' ? ['notes.txt'] : [];
      }),
    mergeAndClose: () => Effect.void,
  });
  const source = fakeSource([sampleTicket(1)]);
  const ledger = makeLedgerMemory();

  await Effect.runPromise(
    executeEngine({ project, workspace: 'worktree' }).pipe(
      Random.withSeed('test'),
      Effect.provide(
        Layer.mergeAll(
          EngineStartupTest,
          dirtyRoot,
          ledger.layer,
          source.layer,
          HarnessSelectorNoop,
          capturingImplementation(ran),
          TestClock.layer()
        )
      )
    )
  );

  expect(ran).toEqual([sampleTicket(1)]);
  expect(asked).toEqual([ticketWorktreeOf(id(1)).path]);
  expect([...ledger.done]).toEqual([id(1)]);
});
