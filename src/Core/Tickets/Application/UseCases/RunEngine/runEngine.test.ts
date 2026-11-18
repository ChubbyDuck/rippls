import * as NodeServices from '@effect/platform-node/NodeServices';
import { ConfigProvider, Console, Duration, Effect, FileSystem, Fiber, Layer, Path, Random, Result, Schema } from 'effect';
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
import type { ReportedEvent } from '~/Core/Tickets/Domain/Events/TicketEvent';
import { EngineHalted } from '~/Core/Tickets/Domain/Exceptions/EngineHalted';
import { RepositoryRootNotFound } from '~/Core/Tickets/Domain/Exceptions/RepositoryRootNotFound';
import { StrategyRuntimeError } from '~/Core/Tickets/Domain/Exceptions/StrategyRuntimeError';
import { TicketEventNotReported } from '~/Core/Tickets/Domain/Exceptions/TicketEventNotReported';
import { TicketNotFound } from '~/Core/Tickets/Domain/Exceptions/TicketNotFound';
import { TicketQuery } from '~/Core/Tickets/Domain/Queries/TicketQuery';
import { renderPrompt } from '~/Core/Tickets/Domain/Services/promptTemplate';
import { WorktreeCloseError } from '~/Core/Tickets/Domain/Exceptions/WorktreeCloseError';
import { WorktreeCommandError } from '~/Core/Tickets/Domain/Exceptions/WorktreeCommandError';
import { Ledger } from '~/Core/Tickets/Ports/Ledger';
import { StrategySelector } from '~/Core/Tickets/Ports/StrategySelector';
import { type AfterMerge, TicketSource } from '~/Core/Tickets/Ports/TicketSource';
import { type CommandRun, type Worktree, WorktreeManager } from '~/Core/Tickets/Ports/WorktreeManager';
import { makeLedgerMemory } from '~/Infrastructure/Tickets/Ledger/memory';
import { StrategySelectorNoop } from '~/Infrastructure/Tickets/StrategySelector/noop';
import { TicketSourceFolderLive } from '~/Infrastructure/Tickets/TicketSource/folder';
import { WorktreeManagerLive } from '~/Infrastructure/Tickets/WorktreeManager/sandcastle';

import { retryTicket } from '../RetryTicket/retryTicket';

import type { RunEngineCommand } from './command';
import { createEngine } from './createEngine';
import { runEngine as executeEngine } from './runEngine';

const WorktreeManagerNoop = Layer.succeed(WorktreeManager, {
  prepareProject: (project) => Effect.succeed({ path: `/repo/.sandcastle/worktrees/${project}`, branch: project }),
  prepareTicket: ({ id }) =>
    Effect.succeed({ path: `/repo/.sandcastle/worktrees/ticket-${id}`, branch: `ticket-${id}` }),
  runCommand: () => Effect.die('runCommand should not be called'),
  isClean: () => Effect.succeed(true),
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
type Reported = { readonly ticket: TicketId; readonly event: ReportedEvent };

const fakeSource = (
  seed: readonly Ticket[] = [],
  options: {
    readonly report?: (
      ticket: TicketId,
      event: ReportedEvent
    ) => Effect.Effect<void, TicketEventNotReported>;
    readonly reportDone?: (ticket: TicketId, worktree: Worktree) => Effect.Effect<AfterMerge, TicketEventNotReported>;
    readonly unreadable?: readonly UnreadableTicket[];
  } = {}
) => {
  const store = new Map(seed.map((ticket) => [ticket.id, ticket]));
  const scopeReads: TicketQuery[] = [];
  const reports: Reported[] = [];
  const doneReported: TicketId[] = [];
  const read = (query: TicketQuery) =>
    Array.from(store.values()).filter(
      (ticket) =>
        (query.id === undefined || ticket.id === query.id) &&
        (query.blockedBy === undefined || ticket.isBlockedBy(query.blockedBy)) &&
        (query.project === undefined || ticket.project === query.project)
    );
  const isScopeRead = (query: TicketQuery) => query.id === undefined && query.blockedBy === undefined;
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
  new Claim({ ticket, engine: otherEngine, process: 1, host: 'memory' });

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
  new Ticket({
    id: ticket.id,
    title: ticket.title,
    project: ticket.project,
    kind: ticket.kind,
    hitl: ticket.hitl,
    blockedBy: ticket.blockedBy,
    body: ticket.body,
    doneInSource: true,
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

test('runEngine runs tickets that appear after an empty poll', async () => {
  const first = sampleTicket(1);
  const second = sampleTicket(2);
  const ran: Ticket[] = [];
  const source = fakeSource([first]);
  const layer = Layer.mergeAll(source.layer, HarnessSelectorNoop, capturingImplementation(ran));

  await Effect.runPromise(
    Effect.gen(function* () {
      yield* runEngine({ project }).pipe(Effect.forkChild({ startImmediately: true }));
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
    await runUntil(runEngine({ project }).pipe(Effect.provide(layer)), () => source.doneReported.length === 2)
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
    'Ticket folder:1 -- implementation is preparing worktree ticket-folder:1 from 0003-sandboxed-local-ticket-loop.md',
    'Ticket folder:1 -- implementation is opening worktree ticket-folder:1 at /repo/.sandcastle/worktrees/ticket-folder:1',
    '',
    'Ticket folder:1 -- implementation has no check command configured, so the check is skipped',
    'Ticket folder:1 -- implementation has its work committed in worktree ticket-folder:1',
    'Ticket folder:1 -- implementation is merging worktree ticket-folder:1',
    'Ticket folder:1 -- implementation is done',
    'Ticket folder:2 -- implementation is claimed',
    `Ticket folder:2 -- implementation is taken into the runner ${claiming}`,
    "Ticket folder:2 -- implementation is processed by 'implementation' strategy and 'default' harness using 'default-model'",
    'Ticket folder:2 -- implementation is preparing worktree ticket-folder:2 from 0003-sandboxed-local-ticket-loop.md',
    'Ticket folder:2 -- implementation is opening worktree ticket-folder:2 at /repo/.sandcastle/worktrees/ticket-folder:2',
    '',
    'Ticket folder:2 -- implementation has no check command configured, so the check is skipped',
    'Ticket folder:2 -- implementation has its work committed in worktree ticket-folder:2',
    'Ticket folder:2 -- implementation is merging worktree ticket-folder:2',
    'Ticket folder:2 -- implementation is done',
  ]);
});

test('runEngine claims a ticket in the Ledger before a Runner processes it, and releases it once done', async () => {
  const ledger = makeLedgerMemory();
  const seen: Array<Claim | undefined> = [];
  const source = fakeSource([sampleTicket(1)]);
  const layer = Layer.mergeAll(source.layer, HarnessSelectorNoop, claimRecordingImplementation(ledger, seen));

  expect(await Effect.runPromise(runEngine({ project, limit: 1 }, ledger).pipe(Effect.provide(layer)))).toBeUndefined();
  expect(seen).toEqual([new Claim({ ticket: id(1), engine: engineId, process: 1, host: 'memory', runner: claiming })]);
  expect(source.doneReported).toEqual([id(1)]);
  expect([...ledger.done]).toEqual([id(1)]);
  expect(ledger.claims.size).toBe(0);
});

test('runEngine narrates taking tickets and continuing after an empty poll', async () => {
  const messages: string[] = [];
  const layer = Layer.mergeAll(
    fakeSource([sampleTicket(1), sampleTicket(2)]).layer,
    HarnessSelectorNoop,
    StrategySelectorNoop,
    Layer.succeed(Console.Console, capturingConsole(messages))
  );

  expect(
    await runUntil(runEngine({ project }).pipe(Effect.provide(layer)), () =>
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
  expect(source.scopeReads[0]).toEqual(TicketQuery.byProject(project).build());
});

test('runEngine does not scope the read when project is omitted', async () => {
  const source = fakeSource([sampleTicket()]);
  const layer = Layer.mergeAll(source.layer, HarnessSelectorNoop, StrategySelectorNoop);

  expect(await runUntil(runEngine().pipe(Effect.provide(layer)), () => source.scopeReads.length > 0)).toBeUndefined();
  expect(source.scopeReads[0]).toEqual(TicketQuery.build());
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
      query.id === undefined && query.blockedBy === undefined
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
      query.id === undefined && query.blockedBy === undefined
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

test('runEngine does not take a ticket while its blocker is not done, and takes it once the blocker is done', async () => {
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
      const fiber = yield* runEngine({ project }).pipe(Effect.provide(layer), Effect.forkChild({ startImmediately: true }));
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

test('runEngine prints the unreadable tickets, the unresolved blockers, and the files without a numeric prefix at start, then takes its Eligible tickets', async () => {
  const ran: Ticket[] = [];
  const messages: string[] = [];
  const unreadable = [
    new UnreadableTicket({ name: 'README.md', reason: 'no numeric prefix' }),
    new UnreadableTicket({ name: 'web/notes.md', reason: 'no numeric prefix' }),
    new UnreadableTicket({
      name: '07-broken.md',
      id: id(7),
      reason: 'unparseable front matter',
      detail: 'it has no closing `---`',
    }),
    new UnreadableTicket({
      name: '08-unknown-kind.md',
      id: id(8),
      reason: 'invalid hint',
      detail: 'Expected "implementation" | "research", got "chore" at ["kind"]',
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
  expect(messages.slice(0, 4)).toEqual([
    'folder:7 (07-broken.md) is unreadable and is not taken: unparseable front matter: it has no closing `---`',
    'folder:8 (08-unknown-kind.md) is unreadable and is not taken: invalid hint: Expected "implementation" | "research", got "chore" at ["kind"]',
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

test('runEngine releases a Claim the Source cannot confirm and takes another ticket', async () => {
  const ledger = makeLedgerMemory();
  const seen: Array<Claim | undefined> = [];
  const source = fakeSource([sampleTicket(1), sampleTicket(2)], {
    report: (ticket, event) =>
      ticket === id(1) && event === 'claimed'
        ? Effect.fail(new TicketEventNotReported({ ticketId: ticket, event }))
        : Effect.void,
  });
  const layer = Layer.mergeAll(
    source.layer,
    HarnessSelectorNoop,
    claimRecordingImplementation(ledger, seen)
  );

  expect(await Effect.runPromise(runEngine({ project, limit: 1 }, ledger).pipe(Effect.provide(layer)))).toBeUndefined();
  expect(seen.map((claim) => claim?.ticket)).toEqual([id(2)]);
  expect(ledger.claims.has(id(1))).toBe(false);
  expect(source.reports).toEqual([{ ticket: id(2), event: 'claimed' }]);
});

const failingStrategy = Layer.succeed(StrategySelector, {
  select: () =>
    Effect.succeed({
      name: 'implementation',
      run: () => Effect.succeed(Result.fail(new StrategyRuntimeError())),
    }),
});

test('runEngine records an escalation in the Ledger, reports no done to the Source, and halts when the strategy fails', () => {
  const ledger = makeLedgerMemory();
  const source = fakeSource([sampleTicket(1), sampleTicket(2)]);
  const layer = Layer.mergeAll(source.layer, HarnessSelectorNoop, failingStrategy);

  expect(Effect.runSync(runEngine({ project }, ledger).pipe(Effect.provide(layer), Effect.flip))).toEqual(
    new EngineHalted({ ticketId: id(1), reason: 'strategy failure' })
  );
  expect([...ledger.escalated.values()]).toEqual([
    new Escalation({
      ticket: id(1),
      reason: 'strategy failure',
      attempts: 1,
      worktree: '/repo/.sandcastle/worktrees/ticket-folder:1',
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
        const path = `/repo/.sandcastle/worktrees/ticket-${ticket}`;
        prepared.push(path);
        return { path, branch: `ticket-${ticket}` };
      }),
    runCommand: () => Effect.die('runCommand should not be called'),
    isClean: () => Effect.succeed(true),
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
    isClean: () => Effect.succeed(true),
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

test('runEngine reports done to the Source, merges and closes, records done in the Ledger, then releases the Claim', async () => {
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
    `after the merge ${id(1)}`,
    `done in the Ledger ${id(1)}`,
    `Claim released ${id(1)}`,
  ]);
});

test('runEngine records no done in the Ledger when the merge fails, halts, and releases its Claim on exit', async () => {
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
  expect(source.doneReported).toEqual([id(1)]);
  expect(ledger.done.size).toBe(0);
  expect(ledger.claims.size).toBe(0);
  expect(source.reports).toEqual([
    { ticket: id(1), event: 'claimed' },
    { ticket: id(1), event: 'released' },
  ]);
});

test('runEngine leaves the ticket file in place and records no done in the Ledger when the merge of the Worktree Manager conflicts', async () => {
  const ledger = makeLedgerMemory();
  const git = (cwd: string, args: readonly string[]) =>
    ChildProcessSpawner.ChildProcessSpawner.pipe(
      Effect.flatMap((spawner) => spawner.string(ChildProcess.make('git', args, { cwd })))
    );
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({ prefix: 'engine-merge-conflict-' });
      const ticketsDir = path.join(root, '.agents', 'tickets');
      const ticketFile = path.join(ticketsDir, '01-conflict.md');
      const content = standardTemplate('01', 'Conflict', 'None (can start immediately)');
      yield* git(root, ['init', '-b', 'main']);
      yield* git(root, ['config', 'user.email', 'test@test.com']);
      yield* git(root, ['config', 'user.name', 'Test']);
      yield* fs.makeDirectory(ticketsDir, { recursive: true });
      yield* fs.writeFileString(ticketFile, content);
      yield* fs.writeFileString(path.join(root, '.gitignore'), '.sandcastle/\n.agents/\n');
      yield* fs.writeFileString(path.join(root, 'base.txt'), 'from main\n');
      yield* git(root, ['add', '-A']);
      yield* git(root, ['commit', '-m', 'init']);
      // The Agent commits its work in the Ticket Worktree. Meanwhile another
      // change to the same file lands in the Repository Root.
      const conflictingHarness: Harness = {
        name: 'conflicting',
        model: 'test-model',
        run: (_prompt, options) =>
          Effect.gen(function* () {
            yield* fs.writeFileString(path.join(options.cwd!, 'base.txt'), 'the work\n');
            yield* git(options.cwd!, ['commit', '-am', 'feat: the work']);
            yield* fs.writeFileString(path.join(root, 'base.txt'), 'other work\n');
            yield* git(root, ['commit', '-am', 'feat: other work']);
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
        Layer.succeed(HarnessSelector, { select: Effect.succeed(conflictingHarness) }),
        StrategySelectorNoop,
        Layer.succeed(Console.Console, capturingConsole([]))
      );
      const halt = yield* executeEngine({}).pipe(Random.withSeed('test'), Effect.provide(layer), Effect.flip);
      return {
        halt,
        content,
        inPlace: yield* fs.readFileString(ticketFile),
        inDone: yield* fs.exists(path.join(ticketsDir, 'done')),
        mergeInProgress: yield* fs.exists(path.join(root, '.git', 'MERGE_HEAD')),
        rootContent: yield* fs.readFileString(path.join(root, 'base.txt')),
        rootHead: (yield* git(root, ['log', '-1', '--format=%s'])).trim(),
      };
    }).pipe(Effect.provide(NodeServices.layer))
  );

  expect(result.halt).toEqual(new EngineHalted({ ticketId: id(1), reason: 'worktree close failure' }));
  expect(result.inPlace).toBe(result.content);
  expect(result.inDone).toBe(false);
  expect(ledger.done.size).toBe(0);
  expect(ledger.claims.size).toBe(0);
  expect(result.mergeInProgress).toBe(false);
  expect(result.rootContent).toBe('other work\n');
  expect(result.rootHead).toBe('feat: other work');
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

test('runEngine keeps polling when the provided repository has no ticket', async () => {
  const source = fakeSource();
  const layer = Layer.mergeAll(
    source.layer,
    HarnessSelectorNoop,
    StrategySelectorNoop
  );

  await Effect.runPromise(
    Effect.gen(function* () {
      yield* runEngine({ project }).pipe(Effect.forkChild({ startImmediately: true }));
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

test('runEngine source.scopeReads.length at the given pollInterval when empty', async () => {
  const source = fakeSource();
  await Effect.runPromise(
    Effect.gen(function* () {
      const layer = Layer.mergeAll(
        source.layer,
        HarnessSelectorNoop,
        StrategySelectorNoop
      );
      yield* runEngine({ project, pollInterval: '2 seconds' }).pipe(
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

test('runEngine source.scopeReads.length once every 10 seconds when empty regardless of runner concurrency', async () => {
  const source = fakeSource();
  await Effect.runPromise(
    Effect.gen(function* () {
      const layer = Layer.mergeAll(
        source.layer,
        HarnessSelectorNoop,
        StrategySelectorNoop
      );
      yield* runEngine({ project, concurrency: 3 }).pipe(
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
    await Effect.runPromise(runEngine({ project, limit: 2, concurrency: 2 }, ledger).pipe(Effect.provide(layer)))
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
      const fiber = yield* runEngine({ project, concurrency: 2 }).pipe(
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

test('runEngine replaces a stale Claim: it reports released before the new claimed, and takes the ticket', async () => {
  const ran: Ticket[] = [];
  const ledger = makeLedgerMemory();
  const source = fakeSource([sampleTicket(1)]);
  // The other Engine's process no longer runs on this host.
  ledger.claims.set(id(1), new Claim({ ticket: id(1), engine: otherEngine, process: 2, host: 'memory' }));
  const layer = Layer.mergeAll(source.layer, HarnessSelectorNoop, capturingImplementation(ran));

  expect(await Effect.runPromise(runEngine({ project, limit: 1 }, ledger).pipe(Effect.provide(layer)))).toBeUndefined();
  expect(ran.map((ticket) => ticket.id)).toEqual([id(1)]);
  expect(source.reports).toEqual([
    { ticket: id(1), event: 'released' },
    { ticket: id(1), event: 'claimed' },
  ]);
});

test('runEngine does not take a ticket whose Claim another running Engine holds', async () => {
  const ran: Ticket[] = [];
  const ledger = makeLedgerMemory();
  const source = fakeSource([sampleTicket(1), sampleTicket(2)]);
  const live = new Claim({ ticket: id(1), engine: otherEngine, process: 2, host: 'memory' });
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

test('runEngine stops the run when Idle for five minutes', async () => {
  const source = fakeSource();
  let stopped = false;
  const messages: string[] = [];

  await Effect.runPromise(
    Effect.gen(function* () {
      const layer = Layer.mergeAll(
        source.layer,
        HarnessSelectorNoop,
        StrategySelectorNoop,
        Layer.succeed(Console.Console, capturingConsole(messages))
      );
      const fiber = yield* runEngine({ project }).pipe(
        Effect.provide(layer),
        Effect.ensuring(
          Effect.sync(() => {
            stopped = true;
          })
        ),
        Effect.forkChild({ startImmediately: true })
      );

      yield* TestClock.adjust('5 minutes');
      yield* Fiber.join(fiber);
      expect(stopped).toBe(true);
      expect(source.scopeReads.length).toBeGreaterThan(0);
      expect(messages).toContain('The Engine was Idle for five minutes. Engine is shutting down.');
    }).pipe(Effect.provide(TestClock.layer()))
  );
});

test('runEngine stops the run when Idle for the given idleTimeout', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const layer = Layer.mergeAll(
        fakeSource().layer,
        HarnessSelectorNoop,
        StrategySelectorNoop
      );
      const fiber = yield* runEngine({ project, idleTimeout: '30 seconds' }).pipe(
        Effect.provide(layer),
        Effect.forkChild({ startImmediately: true })
      );

      yield* TestClock.adjust('29 seconds');
      expect(fiber.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust('1 second');
      yield* Fiber.join(fiber);
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
      const fiber = yield* runEngine({ project, concurrency: 2 }).pipe(
        Effect.provide(layer),
        Effect.forkChild({ startImmediately: true })
      );

      yield* TestClock.adjust('6 minutes');
      expect(fiber.pollUnsafe()).toBeUndefined();
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(TestClock.layer()))
  );
});

test('runEngine starts a fresh Idle window after Ticket Processing ends', async () => {
  const ran: Ticket[] = [];
  await Effect.runPromise(
    Effect.gen(function* () {
      const layer = Layer.mergeAll(
        fakeSource([sampleTicket(1)]).layer,
        HarnessSelectorNoop,
        capturingImplementation(ran)
      );
      const fiber = yield* runEngine({ project }).pipe(
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

test('runEngine zeros the Idle clock when a Claim starts', async () => {
  const emitted: Ticket[] = [];
  const source = fakeSource();

  await Effect.runPromise(
    Effect.gen(function* () {
      const layer = Layer.mergeAll(
        source.layer,
        HarnessSelectorNoop,
        capturingImplementation(emitted)
      );
      const fiber = yield* runEngine({ project }).pipe(
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

test('runEngine creates a missing worktrees directory under the repository root', async () => {
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

      yield* executeEngine({ limit: 0 }).pipe(Random.withSeed('test'), Effect.provide(layer));
      expect(yield* fs.exists(worktrees)).toBe(true);
      expect(messages).toEqual([
        `Worktrees directory is creating at ${worktrees}`,
        `Worktrees directory is ready at ${worktrees}`,
      ]);
    }).pipe(Effect.provide(NodeServices.layer))
  );
});

test('runEngine stops before any ticket when the worktrees directory is not writable', async () => {
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

      const error = yield* executeEngine({ project, limit: 1 }).pipe(
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

test('runEngine proceeds when the worktrees directory is writable', async () => {
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

      yield* executeEngine({ project, limit: 1 }).pipe(Random.withSeed('test'), Effect.provide(layer));
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
    isClean: (worktree) =>
      Effect.sync(() => {
        if (pendingStates === undefined) {
          return true;
        }
        const clean = pendingStates.shift();
        if (clean === undefined) {
          throw new Error('no worktree state left');
        }
        timeline.push(`${worktree.path} is ${clean ? 'clean' : 'dirty'}`);
        return clean;
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
    new Escalation({ ticket: id(1), reason: 'check failure', attempts: 1, worktree: worktreeOf(id(1)) }),
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

  expect(error).toEqual(new EngineHalted({ ticketId: id(1), reason: 'strategy failure' }));
  expect(timeline).toEqual([]);
});

// Runs the Engine on one ticket with the given check and commit config, the check
// runs in `runs`, and the worktree states in `states`.
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
    executeEngine({ project, limit: 1, check, commit }).pipe(Random.withSeed('test'), Effect.provide(layer), Effect.result)
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
    new Escalation({ ticket: id(1), reason: 'commit failure', attempts: 1, worktree: worktreeOf(id(1)) }),
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

// Runs the Engine on one ticket whose Strategy succeeds, with the given Worktree
// Manager and Harness, and no check command.
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
    executeEngine({ project, limit: 1 }).pipe(Random.withSeed('test'), Effect.provide(layer), Effect.result)
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
    isClean: () => Effect.fail(new WorktreeCommandError()),
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
