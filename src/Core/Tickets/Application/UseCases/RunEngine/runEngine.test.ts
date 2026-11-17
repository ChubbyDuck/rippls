import * as NodeServices from '@effect/platform-node/NodeServices';
import { Console, Effect, FileSystem, Fiber, Layer, Path, Random, Result, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, test } from 'vitest';

import { RunnerId, runnerIdFrom } from '~/Core/Shared/Domain/Properties/RunnerId';
import { RepositoryRoot } from '~/Core/Shared/Domain/RepositoryRoot';
import type { Harness } from '~/Core/Shared/Ports/Harness';
import { HarnessSelector } from '~/Core/Shared/Ports/HarnessSelector';
import { Ticket } from '~/Core/Tickets/Domain/Entities/Ticket/entity';
import { formatTicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';
import { Project } from '~/Core/Tickets/Domain/Entities/Ticket/properties/Project';
import { EngineHalted } from '~/Core/Tickets/Domain/Exceptions/EngineHalted';
import { RepositoryRootNotFound } from '~/Core/Tickets/Domain/Exceptions/RepositoryRootNotFound';
import { StrategyRuntimeError } from '~/Core/Tickets/Domain/Exceptions/StrategyRuntimeError';
import { TicketNotFound } from '~/Core/Tickets/Domain/Exceptions/TicketNotFound';
import { TicketNotSaved } from '~/Core/Tickets/Domain/Exceptions/TicketNotSaved';
import { TicketQuery } from '~/Core/Tickets/Domain/Queries/TicketQuery';
import { StrategySelector } from '~/Core/Tickets/Ports/StrategySelector';
import { TicketSource } from '~/Core/Tickets/Ports/TicketSource';
import { WorktreeManager } from '~/Core/Tickets/Ports/WorktreeManager';
import { StrategySelectorNoop } from '~/Infrastructure/Tickets/StrategySelector/noop';

import type { RunEngineCommand } from './command';
import { createEngine } from './createEngine';
import { runEngine as executeEngine } from './runEngine';

const WorktreeManagerNoop = Layer.succeed(WorktreeManager, {
  prepareProject: (project) => Effect.succeed({ path: `/repo/.sandcastle/worktrees/${project}`, branch: project }),
  prepareTicket: ({ id }) =>
    Effect.succeed({ path: `/repo/.sandcastle/worktrees/ticket-${id}`, branch: `ticket-${id}` }),
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

const runEngine = (command: RunEngineCommand = {}) =>
  executeEngine(command).pipe(Random.withSeed('test'), Effect.provide(EngineStartupTest));
const engineId = Effect.runSync(createEngine.pipe(Random.withSeed('test'))).id;

const project = Schema.decodeSync(Project)('0003-sandboxed-local-ticket-loop.md');
const id = (value: number) => formatTicketId('folder', String(value));

// A fake Source that keeps tickets in memory, in the order they were added. A read
// for the tickets in scope returns every one of them, narrowed only by Project:
// the Engine, not the Source, decides which ticket is Eligible. The other reads
// (by identity, blocked-by, and claimed) answer as the real Sources do. A saved
// ticket replaces the stored one, so a claimed ticket stays claimed.
const fakeSource = (
  seed: readonly Ticket[] = [],
  options: { readonly save?: (ticket: Ticket) => Effect.Effect<void, TicketNotSaved> } = {}
) => {
  const store = new Map(seed.map((ticket) => [ticket.id, ticket]));
  const scopeReads: TicketQuery[] = [];
  const read = (query: TicketQuery) =>
    Array.from(store.values()).filter(
      (ticket) =>
        (query.id === undefined || ticket.id === query.id) &&
        (query.blockedBy === undefined || ticket.isBlockedBy(query.blockedBy)) &&
        (query.claimed !== true || ticket.status === 'claiming' || ticket.status === 'claimed') &&
        (query.project === undefined || ticket.project === query.project)
    );
  const isScopeRead = (query: TicketQuery) =>
    query.id === undefined && query.blockedBy === undefined && query.claimed === undefined;
  const save = (ticket: Ticket): Effect.Effect<void, TicketNotSaved> =>
    (options.save ?? (() => Effect.void))(ticket).pipe(
      Effect.andThen(
        Effect.sync(() => {
          store.set(ticket.id, ticket);
        })
      )
    );
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
    save,
    saveMany: (tickets) => Effect.forEach(tickets, save, { discard: true }),
  });
  const add = (ticket: Ticket) => {
    store.set(ticket.id, ticket);
  };
  return { layer, store, scopeReads, add };
};

const sampleTicket = (value = 1) =>
  Ticket.create({
    id: id(value),
    title: 'Random ticket',
    project,
    kind: 'implementation',
    hitl: 'no',
    status: 'ready-for-agent',
    blockedBy: [],
    blocks: [],
    body: '',
  });

const blockedTicket = (value: number, blockedBy: number) =>
  Ticket.create({
    id: id(value),
    title: 'Blocked ticket',
    project,
    kind: 'implementation',
    hitl: 'no',
    status: 'ready-for-agent',
    blockedBy: [id(blockedBy)],
    blocks: [],
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
  expect(ran).toEqual([first.claim({ by: claiming }), second.claim({ by: claiming })]);
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
      expect(ran).toEqual([first.claim({ by: claiming })]);
      source.add(second);
      yield* TestClock.adjust('10 seconds');
      expect(ran).toEqual([first.claim({ by: claiming }), second.claim({ by: claiming })]);
    }).pipe(Effect.provide(Layer.mergeAll(layer, TestClock.layer())))
  );
});

test('runEngine claims each ticket and writes the claim before continuing', async () => {
  const saved: Ticket[] = [];
  const messages: string[] = [];
  const layer = Layer.mergeAll(
    fakeSource([sampleTicket(1), sampleTicket(2)], {
      save: (ticket) =>
        Effect.sync(() => {
          saved.push(ticket);
        }),
    }).layer,
    HarnessSelectorNoop,
    StrategySelectorNoop,
    Layer.succeed(Console.Console, capturingConsole(messages))
  );

  expect(await runUntil(runEngine({ project }).pipe(Effect.provide(layer)), () => saved.length === 6)).toBeUndefined();
  expect(saved).toEqual([
    sampleTicket(1).markClaiming(),
    sampleTicket(1).claim({ by: claiming }),
    sampleTicket(1).claim({ by: claiming }).done(),
    sampleTicket(2).markClaiming(),
    sampleTicket(2).claim({ by: claiming }),
    sampleTicket(2).claim({ by: claiming }).done(),
  ]);
  expect(messages.filter((message) => message !== 'No tickets are found, continuing')).toEqual([
    `Ticket folder:1 -- implementation is taken into the runner ${claiming}`,
    'Ticket folder:1 -- implementation is claimed',
    "Ticket folder:1 -- implementation is processed by 'implementation' strategy and 'default' harness using 'default-model'",
    'Ticket folder:1 -- implementation is preparing worktree ticket-folder:1 from 0003-sandboxed-local-ticket-loop.md',
    'Ticket folder:1 -- implementation is opening worktree ticket-folder:1 at /repo/.sandcastle/worktrees/ticket-folder:1',
    '',
    'Ticket folder:1 -- implementation is merging worktree ticket-folder:1',
    'Ticket folder:1 -- implementation is done',
    `Ticket folder:2 -- implementation is taken into the runner ${claiming}`,
    'Ticket folder:2 -- implementation is claimed',
    "Ticket folder:2 -- implementation is processed by 'implementation' strategy and 'default' harness using 'default-model'",
    'Ticket folder:2 -- implementation is preparing worktree ticket-folder:2 from 0003-sandboxed-local-ticket-loop.md',
    'Ticket folder:2 -- implementation is opening worktree ticket-folder:2 at /repo/.sandcastle/worktrees/ticket-folder:2',
    '',
    'Ticket folder:2 -- implementation is merging worktree ticket-folder:2',
    'Ticket folder:2 -- implementation is done',
  ]);
});

test('runEngine runs the matching strategy between claim and done', async () => {
  const saved: Ticket[] = [];
  const ran: Ticket[] = [];
  const layer = Layer.mergeAll(
    fakeSource([sampleTicket(1)], {
      save: (ticket) =>
        Effect.sync(() => {
          saved.push(ticket);
        }),
    }).layer,
    HarnessSelectorNoop,
    capturingImplementation(ran)
  );

  expect(await runUntil(runEngine({ project }).pipe(Effect.provide(layer)), () => ran.length === 1)).toBeUndefined();
  expect(ran).toEqual([sampleTicket(1).claim({ by: claiming })]);
  expect(saved).toEqual([
    sampleTicket(1).markClaiming(),
    sampleTicket(1).claim({ by: claiming }),
    sampleTicket(1).claim({ by: claiming }).done(),
  ]);
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
  const stale = Schema.decodeSync(RunnerId)('stale');
  const attended = Ticket.create({
    id: id(3),
    title: 'Attended ticket',
    project,
    kind: 'task',
    hitl: 'yes',
    status: 'ready-for-agent',
    blockedBy: [],
    blocks: [],
    body: '',
  });
  const source = fakeSource([
    sampleTicket(6),
    blockedTicket(1, 99),
    sampleTicket(2).claim({ by: stale }),
    attended,
    sampleTicket(4).markClaiming(),
    sampleTicket(5),
  ]);
  const layer = Layer.mergeAll(source.layer, HarnessSelectorNoop, capturingImplementation(ran));

  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* runEngine({ project }).pipe(Effect.provide(layer), Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust('0 millis');
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(TestClock.layer()))
  );

  expect(ran.map((ticket) => ticket.id)).toEqual([id(6), id(5)]);
});

test('runEngine takes the chosen ticket as the Source reads it by identity', async () => {
  const ran: Ticket[] = [];
  const fields = {
    id: id(1),
    title: 'Full ticket',
    project,
    kind: 'implementation',
    status: 'ready-for-agent',
    blockedBy: [],
    blocks: [],
  };
  const full = Ticket.create({ ...fields, body: 'The whole body.' });
  const head = Ticket.create({ ...fields, body: '' });
  const source = fakeSource([full]);
  const headOnly = Layer.succeed(TicketSource, {
    ...Effect.runSync(TicketSource.pipe(Effect.provide(source.layer))),
    getManyBy: (query) =>
      query.id === undefined && query.claimed === undefined && query.blockedBy === undefined
        ? Effect.succeed([head])
        : Effect.succeed([]),
  });
  const layer = Layer.mergeAll(headOnly, HarnessSelectorNoop, capturingImplementation(ran));

  expect(await Effect.runPromise(runEngine({ project, limit: 1 }).pipe(Effect.provide(layer)))).toBeUndefined();
  expect(ran).toEqual([full.claim({ by: claiming })]);
});

test('runEngine takes the next Eligible ticket when the chosen one is no longer Eligible by identity', async () => {
  const ran: Ticket[] = [];
  const stale = Schema.decodeSync(RunnerId)('stale');
  const source = fakeSource([sampleTicket(1).claim({ by: stale }), sampleTicket(2)]);
  const staleList = Layer.succeed(TicketSource, {
    ...Effect.runSync(TicketSource.pipe(Effect.provide(source.layer))),
    getManyBy: (query) =>
      query.id === undefined && query.claimed === undefined && query.blockedBy === undefined
        ? Effect.succeed([sampleTicket(1), sampleTicket(2)])
        : Effect.succeed([]),
  });
  const layer = Layer.mergeAll(staleList, HarnessSelectorNoop, capturingImplementation(ran));

  expect(await Effect.runPromise(runEngine({ project, limit: 1 }).pipe(Effect.provide(layer)))).toBeUndefined();
  expect(ran).toEqual([sampleTicket(2).claim({ by: claiming })]);
  expect(source.store.get(id(1))?.claimedBy).toBe(stale);
});

test('runEngine takes a blocked ticket once its blocker is done, without writing to it before', async () => {
  const saved: Ticket[] = [];
  const ran: Ticket[] = [];
  // Ticket 1 comes first in the order of the Source, so it would be taken first if
  // it were Eligible while ticket 2 is open. Its stored status does not gate it.
  const dependent = Ticket.create({
    id: id(1),
    title: 'Dependent ticket',
    project,
    kind: 'implementation',
    status: 'blocked',
    blockedBy: [id(2)],
    blocks: [],
    body: '',
  });
  const blocker = sampleTicket(2);
  const source = fakeSource([dependent, blocker], {
    save: (ticket) =>
      Effect.sync(() => {
        saved.push(ticket);
      }),
  });
  const layer = Layer.mergeAll(source.layer, HarnessSelectorNoop, capturingImplementation(ran));

  expect(await Effect.runPromise(runEngine({ project, limit: 2 }).pipe(Effect.provide(layer)))).toBeUndefined();
  expect(ran).toEqual([blocker.claim({ by: claiming }), dependent.claim({ by: claiming })]);
  expect(saved).toEqual([
    blocker.markClaiming(),
    blocker.claim({ by: claiming }),
    blocker.claim({ by: claiming }).done(),
    dependent.markClaiming(),
    dependent.claim({ by: claiming }),
    dependent.claim({ by: claiming }).done(),
  ]);
});

test('runEngine does not take a ticket while its blocker is not done, and takes it once the blocker is done', async () => {
  const ran: Ticket[] = [];
  const saved: Ticket[] = [];
  const attendedBlocker = Ticket.create({
    id: id(2),
    title: 'Attended blocker',
    project,
    kind: 'task',
    hitl: 'yes',
    status: 'ready-for-agent',
    blockedBy: [],
    blocks: [],
    body: '',
  });
  const dependent = blockedTicket(1, 2);
  const source = fakeSource([dependent, attendedBlocker], {
    save: (ticket) =>
      Effect.sync(() => {
        saved.push(ticket);
      }),
  });
  const layer = Layer.mergeAll(source.layer, HarnessSelectorNoop, capturingImplementation(ran));

  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* runEngine({ project }).pipe(Effect.provide(layer), Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust('0 millis');
      expect(ran).toEqual([]);
      expect(saved).toEqual([]);
      source.add(attendedBlocker.done());
      yield* TestClock.adjust('10 seconds');
      expect(ran).toEqual([dependent.claim({ by: claiming })]);
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(TestClock.layer()))
  );

  expect(saved.filter((ticket) => ticket.id === dependent.id)[0]).toEqual(dependent.markClaiming());
});

test('runEngine keeps a ticket blocked by a blocker that the Source cannot find', async () => {
  const ran: Ticket[] = [];
  const source = fakeSource([blockedTicket(1, 99), sampleTicket(2).done()]);
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

test('runEngine resolves a blocker of another Project against every ticket of the Source', async () => {
  const ran: Ticket[] = [];
  const otherProject = Schema.decodeSync(Project)('other');
  const elsewhere = (value: number) =>
    Ticket.create({
      id: id(value),
      title: 'Ticket of another project',
      project: otherProject,
      kind: 'implementation',
      status: 'ready-for-agent',
      blockedBy: [],
      blocks: [],
      body: '',
    });
  const doneElsewhere = elsewhere(2).done();
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

test('runEngine fails when the claim cannot be saved', () => {
  const ran: Ticket[] = [];
  const layer = Layer.mergeAll(
    fakeSource([sampleTicket(1), sampleTicket(2)], { save: () => Effect.fail(new TicketNotSaved()) }).layer,
    HarnessSelectorNoop,
    capturingImplementation(ran)
  );

  expect(Effect.runSync(runEngine({ project }).pipe(Effect.provide(layer), Effect.flip))).toEqual(
    new TicketNotSaved()
  );
  expect(ran).toEqual([]);
});

test('runEngine escalates the ticket and halts when the strategy reports a failure', () => {
  const saved: Ticket[] = [];
  const layer = Layer.mergeAll(
    fakeSource([sampleTicket(1), sampleTicket(2)], {
      save: (ticket) =>
        Effect.sync(() => {
          saved.push(ticket);
        }),
    }).layer,
    HarnessSelectorNoop,
    Layer.succeed(StrategySelector, {
      select: () =>
        Effect.succeed({
          name: 'implementation',
          run: () => Effect.succeed(Result.fail(new StrategyRuntimeError())),
        }),
    })
  );

  expect(Effect.runSync(runEngine({ project }).pipe(Effect.provide(layer), Effect.flip))).toBeInstanceOf(
    EngineHalted
  );
  expect(saved).toEqual([
    sampleTicket(1).markClaiming(),
    sampleTicket(1).claim({ by: claiming }),
    sampleTicket(1).claim({ by: claiming }).escalate(),
  ]);
});

test('runEngine fails when the done write cannot be saved', () => {
  const saved: Ticket[] = [];
  const ran: Ticket[] = [];
  const layer = Layer.mergeAll(
    fakeSource([sampleTicket(1), sampleTicket(2)], {
      save: (ticket) =>
        ticket.status === 'done'
          ? Effect.fail(new TicketNotSaved())
          : Effect.sync(() => {
              saved.push(ticket);
            }),
    }).layer,
    HarnessSelectorNoop,
    capturingImplementation(ran)
  );

  expect(Effect.runSync(runEngine({ project }).pipe(Effect.provide(layer), Effect.flip))).toEqual(
    new TicketNotSaved()
  );
  expect(ran).toEqual([sampleTicket(1).claim({ by: claiming })]);
  expect(saved).toEqual([
    sampleTicket(1).markClaiming(),
    sampleTicket(1).claim({ by: claiming }),
    sampleTicket(1).claim({ by: claiming }).release(),
  ]);
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
      expect(source.scopeReads.length).toBe(1);
      yield* TestClock.adjust('10 seconds');
      expect(source.scopeReads.length).toBe(2);
      yield* TestClock.adjust('10 seconds');
      expect(source.scopeReads.length).toBe(3);
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
  expect(ran).toEqual([first.claim({ by: claiming }), second.claim({ by: claiming })]);
});

test('runEngine starts one runner by default and claims with an engine-derived id', async () => {
  const saved: Ticket[] = [];
  const layer = Layer.mergeAll(
    fakeSource([sampleTicket(1)], {
      save: (ticket) =>
        Effect.sync(() => {
          saved.push(ticket);
        }),
    }).layer,
    HarnessSelectorNoop,
    StrategySelectorNoop
  );

  expect(await Effect.runPromise(runEngine({ project, limit: 1 }).pipe(Effect.provide(layer)))).toBeUndefined();
  expect(saved.map((ticket) => ticket.claimedBy)).toEqual([undefined, claiming, claiming]);
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
      expect(source.scopeReads.length).toBe(1);
      yield* TestClock.adjust('1999 millis');
      expect(source.scopeReads.length).toBe(1);
      yield* TestClock.adjust('1 millis');
      expect(source.scopeReads.length).toBe(2);
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
      expect(source.scopeReads.length).toBe(1);
      yield* TestClock.adjust('10 seconds');
      expect(source.scopeReads.length).toBe(2);
      yield* TestClock.adjust('10 seconds');
      expect(source.scopeReads.length).toBe(3);
    }).pipe(Effect.provide(TestClock.layer()))
  );
});

test('runEngine claims queued tickets with distinct runners when concurrency allows', async () => {
  const saved: Ticket[] = [];
  const layer = Layer.mergeAll(
    fakeSource([sampleTicket(1), sampleTicket(2)], {
      save: (ticket) =>
        Effect.sync(() => {
          saved.push(ticket);
        }),
    }).layer,
    HarnessSelectorNoop,
    StrategySelectorNoop
  );

  expect(
    await Effect.runPromise(runEngine({ project, limit: 2, concurrency: 2 }).pipe(Effect.provide(layer)))
  ).toBeUndefined();
  expect(
    new Set(saved.filter((ticket) => ticket.status === 'claimed').map((ticket) => ticket.claimedBy))
  ).toEqual(new Set([claiming, runnerIdFrom(engineId, '1')]));
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
  expect(ran).toEqual([first.claim({ by: claiming }), second.claim({ by: claiming })]);
  expect(source.scopeReads).toHaveLength(2);
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
  expect(store.get(id(2))?.status).toBe('ready-for-agent');
});

test('runEngine releases every claiming and claimed ticket when the run fails', async () => {
  const stale = Schema.decodeSync(RunnerId)('stale');
  const alreadyClaiming = sampleTicket(2).markClaiming();
  const { layer: repo, store } = fakeSource([sampleTicket(1), alreadyClaiming, blockedTicket(3, 1)]);
  const failingStrategy = Layer.succeed(StrategySelector, {
    select: () =>
      Effect.succeed({
        name: 'implementation',
        run: () => Effect.succeed(Result.fail(new StrategyRuntimeError())),
      }),
  });
  // Seed a second claimed ticket that no runner owns any more.
  store.set(id(4), sampleTicket(4).claim({ by: stale }));
  const layer = Layer.mergeAll(repo, HarnessSelectorNoop, failingStrategy);

  const outcome = await Effect.runPromise(
    runEngine({ project, concurrency: 1 }).pipe(Effect.provide(layer), Effect.flip)
  );

  expect(outcome).toBeInstanceOf(EngineHalted);
  // The failed ticket 1 is escalated to a human, so it is no longer claimed.
  expect(store.get(id(1))?.status).toBe('ready-for-agent');
  expect(store.get(id(1))?.kind).toBe('task');
  expect(store.get(id(1))?.claimedBy).toBeUndefined();
  expect(store.get(id(2))?.status).toBe('ready-for-agent');
  expect(store.get(id(4))?.status).toBe('ready-for-agent');
  expect(store.get(id(4))?.claimedBy).toBeUndefined();
  expect(store.get(id(3))?.status).toBe('ready-for-agent');
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
      expect(ran).toEqual([sampleTicket(1).claim({ by: claiming })]);
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
      expect(emitted).toEqual([sampleTicket(1).claim({ by: claiming })]);
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
        WorktreeManagerNoop
      );

      yield* executeEngine({ project, limit: 1 }).pipe(Random.withSeed('test'), Effect.provide(layer));
      expect(ran).toEqual([ticket.claim({ by: claiming })]);
    }).pipe(Effect.provide(NodeServices.layer))
  );
});

test('runEngine does not claim a ticket when the Repository Root cannot be found', async () => {
  const claimed: Ticket[] = [];
  const error = await Effect.runPromise(
    executeEngine({ project, limit: 1 }).pipe(
      Random.withSeed('test'),
      Effect.provide(
        Layer.mergeAll(
          fakeSource([sampleTicket(1)], {
            save: (ticket) =>
              Effect.sync(() => {
                claimed.push(ticket);
              }),
          }).layer,
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
  expect(claimed).toEqual([]);
});
