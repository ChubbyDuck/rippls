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

type TicketSourceShape = {
  getOneBy: (query: TicketQuery) => Effect.Effect<Ticket, TicketNotFound>;
  getManyBy: (query: TicketQuery) => Effect.Effect<readonly Ticket[]>;
  save: (ticket: Ticket) => Effect.Effect<void, TicketNotSaved>;
  saveMany: (tickets: readonly Ticket[]) => Effect.Effect<void, TicketNotSaved>;
};

// The engine polls with a no-id query (pollTicket), while completeTicket reloads
// the finished ticket with a by-id query. This helper serves the by-id read from
// what save persisted, so a test only needs to script the poll source through the
// getOneBy override. By-id reads never advance that source and are not counted.
const repoOf = (overrides: Partial<TicketSourceShape>) => {
  const store = new Map();
  const poll = overrides.getOneBy ?? (() => Effect.fail(new TicketNotFound()));
  const saveOverride = overrides.save ?? (() => Effect.void);
  const save = (ticket: Ticket): Effect.Effect<void, TicketNotSaved> =>
    Effect.sync(() => {
      store.set(ticket.id, ticket);
    }).pipe(Effect.andThen(() => saveOverride(ticket)));
  return Layer.succeed(TicketSource, {
    getOneBy: (query) => {
      if (query.id === undefined) {
        return poll(query);
      }
      const found = store.get(query.id);
      return found === undefined ? Effect.fail(new TicketNotFound()) : Effect.succeed(found);
    },
    getManyBy: overrides.getManyBy ?? (() => Effect.succeed([])),
    save,
    saveMany: overrides.saveMany ?? ((tickets) => Effect.forEach(tickets, save, { discard: true })),
  });
};

const project = Schema.decodeSync(Project)('0003-sandboxed-local-ticket-loop.md');
const id = (value: number) => formatTicketId('folder', String(value));

const nextReadyTicket = TicketQuery.unblocked().unclaimed().afk().byProject(project).sort('ASC').build();
const nextReadyTicketAnyProject = TicketQuery.unblocked().unclaimed().afk().sort('ASC').build();

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

const matchesQuery =
  (query: TicketQuery) =>
  (ticket: Ticket): boolean => {
    if (query.id !== undefined && ticket.id !== query.id) {
      return false;
    }
    if (query.blockedBy !== undefined && !ticket.isBlockedBy(query.blockedBy)) {
      return false;
    }
    if (query.unblocked === true && ticket.blockedBy.length !== 0) {
      return false;
    }
    if (query.unclaimed === true && (ticket.claimedBy !== undefined || ticket.status === 'claiming')) {
      return false;
    }
    if (query.claimed === true && ticket.status !== 'claiming' && ticket.status !== 'claimed') {
      return false;
    }
    if (query.afk === true && ticket.hitl !== 'no') {
      return false;
    }
    if (query.project !== undefined && ticket.project !== query.project) {
      return false;
    }
    return true;
  };

const inMemoryRepo = (seed: readonly Ticket[]) => {
  const store = new Map(seed.map((ticket) => [ticket.id, ticket]));
  const all = (query: TicketQuery) =>
    Array.from(store.values())
      .filter(matchesQuery(query))
      .sort((left, right) => left.id.localeCompare(right.id));
  const layer = repoOf({
    getOneBy: (query) => {
      const [found] = all(query);
      return found === undefined ? Effect.fail(new TicketNotFound()) : Effect.succeed(found);
    },
    getManyBy: (query) => Effect.succeed(all(query)),
    save: (ticket) =>
      Effect.sync(() => {
        store.set(ticket.id, ticket);
      }),
  });
  return { layer, store };
};

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

const ticketsThenGone = (tickets: readonly Ticket[]) => {
  let remaining = tickets;
  return (received: TicketQuery) => {
    const [next, ...rest] = remaining;
    remaining = rest;
    return next === undefined ? Effect.fail(new TicketNotFound()) : Effect.succeed(next);
  };
};

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
    repoOf({
      getOneBy: ticketsThenGone([first, second]),
      save: () => Effect.void,
    }),
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
  let remaining: Array<Ticket | undefined> = [first, undefined, second];
  const layer = Layer.mergeAll(
    repoOf({
      getOneBy: () => {
        const [next, ...rest] = remaining;
        remaining = rest;
        return next === undefined ? Effect.fail(new TicketNotFound()) : Effect.succeed(next);
      },
      save: () => Effect.void,
    }),
    HarnessSelectorNoop,
    capturingImplementation(ran)
  );

  await Effect.runPromise(
    Effect.gen(function* () {
      yield* runEngine({ project }).pipe(Effect.forkChild({ startImmediately: true }));
      expect(ran).toEqual([first.claim({ by: claiming })]);
      yield* TestClock.adjust('10 seconds');
      expect(ran).toEqual([first.claim({ by: claiming }), second.claim({ by: claiming })]);
    }).pipe(Effect.provide(Layer.mergeAll(layer, TestClock.layer())))
  );
});

test('runEngine claims each ticket and writes the claim before continuing', async () => {
  const saved: Ticket[] = [];
  const messages: string[] = [];
  const layer = Layer.mergeAll(
    repoOf({
      getOneBy: ticketsThenGone([sampleTicket(1), sampleTicket(2)]),
      save: (ticket) =>
        Effect.sync(() => {
          saved.push(ticket);
        }),
    }),
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
    repoOf({
      getOneBy: ticketsThenGone([sampleTicket(1)]),
      save: (ticket) =>
        Effect.sync(() => {
          saved.push(ticket);
        }),
    }),
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
    repoOf({
      getOneBy: ticketsThenGone([sampleTicket(1), sampleTicket(2)]),
      save: () => Effect.void,
    }),
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

test('runEngine queries the next ready ticket in the provided project', async () => {
  let query = undefined as TicketQuery | undefined;
  const next = ticketsThenGone([sampleTicket()]);
  const layer = Layer.mergeAll(
    repoOf({
      getOneBy: (received) => {
        query = received;
        return next(received);
      },
      save: () => Effect.void,
    }),
    HarnessSelectorNoop,
    StrategySelectorNoop
  );

  expect(
    await runUntil(runEngine({ project }).pipe(Effect.provide(layer)), () => query !== undefined)
  ).toBeUndefined();
  expect(query).toEqual(nextReadyTicket);
});

test('runEngine does not scope the query when project is omitted', async () => {
  let query = undefined as TicketQuery | undefined;
  const next = ticketsThenGone([sampleTicket()]);
  const layer = Layer.mergeAll(
    repoOf({
      getOneBy: (received) => {
        query = received;
        return next(received);
      },
      save: () => Effect.void,
    }),
    HarnessSelectorNoop,
    StrategySelectorNoop
  );

  expect(await runUntil(runEngine().pipe(Effect.provide(layer)), () => query !== undefined)).toBeUndefined();
  expect(query).toEqual(nextReadyTicketAnyProject);
});

test('runEngine fails when the claim cannot be saved', () => {
  const ran: Ticket[] = [];
  const layer = Layer.mergeAll(
    repoOf({
      getOneBy: ticketsThenGone([sampleTicket(1), sampleTicket(2)]),
      save: () => Effect.fail(new TicketNotSaved()),
    }),
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
    repoOf({
      getOneBy: ticketsThenGone([sampleTicket(1), sampleTicket(2)]),
      save: (ticket) =>
        Effect.sync(() => {
          saved.push(ticket);
        }),
    }),
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
    repoOf({
      getOneBy: ticketsThenGone([sampleTicket(1), sampleTicket(2)]),
      save: (ticket) =>
        ticket.status === 'done'
          ? Effect.fail(new TicketNotSaved())
          : Effect.sync(() => {
              saved.push(ticket);
            }),
    }),
    HarnessSelectorNoop,
    capturingImplementation(ran)
  );

  expect(Effect.runSync(runEngine({ project }).pipe(Effect.provide(layer), Effect.flip))).toEqual(
    new TicketNotSaved()
  );
  expect(ran).toEqual([sampleTicket(1).claim({ by: claiming })]);
  expect(saved).toEqual([sampleTicket(1).markClaiming(), sampleTicket(1).claim({ by: claiming })]);
});

test('runEngine keeps polling when the provided repository has no ticket', async () => {
  let polls = 0;
  const layer = Layer.mergeAll(
    repoOf({
      getOneBy: () => {
        polls += 1;
        return Effect.fail(new TicketNotFound());
      },
      save: () => Effect.void,
    }),
    HarnessSelectorNoop,
    StrategySelectorNoop
  );

  await Effect.runPromise(
    Effect.gen(function* () {
      yield* runEngine({ project }).pipe(Effect.forkChild({ startImmediately: true }));
      expect(polls).toBe(1);
      yield* TestClock.adjust('10 seconds');
      expect(polls).toBe(2);
      yield* TestClock.adjust('10 seconds');
      expect(polls).toBe(3);
    }).pipe(Effect.provide(Layer.mergeAll(layer, TestClock.layer())))
  );
});

test('runEngine stops after processing the given limit length', async () => {
  const first = sampleTicket(1);
  const second = sampleTicket(2);
  const third = sampleTicket(3);
  const ran: Ticket[] = [];
  const layer = Layer.mergeAll(
    repoOf({
      getOneBy: ticketsThenGone([first, second, third]),
      save: () => Effect.void,
    }),
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
    repoOf({
      getOneBy: ticketsThenGone([sampleTicket(1)]),
      save: (ticket) =>
        Effect.sync(() => {
          saved.push(ticket);
        }),
    }),
    HarnessSelectorNoop,
    StrategySelectorNoop
  );

  expect(await Effect.runPromise(runEngine({ project, limit: 1 }).pipe(Effect.provide(layer)))).toBeUndefined();
  expect(saved.map((ticket) => ticket.claimedBy)).toEqual([undefined, claiming, claiming]);
});

test('runEngine polls at the given pollInterval when empty', async () => {
  let polls = 0;
  await Effect.runPromise(
    Effect.gen(function* () {
      const layer = Layer.mergeAll(
        repoOf({
          getOneBy: () =>
            Effect.suspend(() => {
              polls += 1;
              return Effect.fail(new TicketNotFound());
            }),
          save: () => Effect.void,
        }),
        HarnessSelectorNoop,
        StrategySelectorNoop
      );
      yield* runEngine({ project, pollInterval: '2 seconds' }).pipe(
        Effect.provide(layer),
        Effect.forkChild({ startImmediately: true })
      );
      expect(polls).toBe(1);
      yield* TestClock.adjust('1999 millis');
      expect(polls).toBe(1);
      yield* TestClock.adjust('1 millis');
      expect(polls).toBe(2);
    }).pipe(Effect.provide(TestClock.layer()))
  );
});

test('runEngine polls once every 10 seconds when empty regardless of runner concurrency', async () => {
  let polls = 0;
  await Effect.runPromise(
    Effect.gen(function* () {
      const layer = Layer.mergeAll(
        repoOf({
          getOneBy: () =>
            Effect.suspend(() => {
              polls += 1;
              return Effect.fail(new TicketNotFound());
            }),
          save: () => Effect.void,
        }),
        HarnessSelectorNoop,
        StrategySelectorNoop
      );
      yield* runEngine({ project, concurrency: 3 }).pipe(
        Effect.provide(layer),
        Effect.forkChild({ startImmediately: true })
      );
      yield* TestClock.adjust('0 millis');
      expect(polls).toBe(1);
      yield* TestClock.adjust('10 seconds');
      expect(polls).toBe(2);
      yield* TestClock.adjust('10 seconds');
      expect(polls).toBe(3);
    }).pipe(Effect.provide(TestClock.layer()))
  );
});

test('runEngine claims queued tickets with distinct runners when concurrency allows', async () => {
  const saved: Ticket[] = [];
  const layer = Layer.mergeAll(
    repoOf({
      getOneBy: ticketsThenGone([sampleTicket(1), sampleTicket(2)]),
      save: (ticket) =>
        Effect.sync(() => {
          saved.push(ticket);
        }),
    }),
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
  let reads = 0;
  const nextTicket = ticketsThenGone([first, second, third]);
  const layer = Layer.mergeAll(
    repoOf({
      getOneBy: (query) => {
        reads += 1;
        return nextTicket(query);
      },
      save: () => Effect.void,
    }),
    capturingImplementation(ran),
    HarnessSelectorNoop
  );

  expect(
    await Effect.runPromise(runEngine({ project, limit: 2 }).pipe(Effect.provide(layer)))
  ).toBeUndefined();
  expect(ran).toHaveLength(2);
  expect(ran).toEqual([first.claim({ by: claiming }), second.claim({ by: claiming })]);
  expect(reads).toBe(2);
});

test('runEngine claims a single unblocked ticket once', async () => {
  const ran: Ticket[] = [];
  // Ticket 2 is blocked by ticket 99, which this run never completes, so it stays
  // unavailable. The decoy checks that two workers do not claim ticket 1 twice; it
  // must not depend on ticket 1, because completing ticket 1 would unblock it.
  const { layer: repo, store } = inMemoryRepo([sampleTicket(1), blockedTicket(2, 99)]);
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
  const { layer: repo, store } = inMemoryRepo([sampleTicket(1), alreadyClaiming, blockedTicket(3, 1)]);
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
  let reads = 0;
  let stopped = false;
  const messages: string[] = [];

  await Effect.runPromise(
    Effect.gen(function* () {
      const layer = Layer.mergeAll(
        repoOf({
          getOneBy: () =>
            Effect.suspend(() => {
              reads += 1;
              return Effect.fail(new TicketNotFound());
            }),
          save: () => Effect.void,
        }),
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
      expect(reads).toBeGreaterThan(0);
      expect(messages).toContain('The Engine was Idle for five minutes. Engine is shutting down.');
    }).pipe(Effect.provide(TestClock.layer()))
  );
});

test('runEngine stops the run when Idle for the given idleTimeout', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const layer = Layer.mergeAll(
        repoOf({
          getOneBy: () => Effect.fail(new TicketNotFound()),
          save: () => Effect.void,
        }),
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
        repoOf({
          getOneBy: ticketsThenGone([sampleTicket(1)]),
          save: () => Effect.void,
        }),
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
        repoOf({
          getOneBy: ticketsThenGone([sampleTicket(1)]),
          save: () => Effect.void,
        }),
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
  let available: Ticket | undefined;

  await Effect.runPromise(
    Effect.gen(function* () {
      const layer = Layer.mergeAll(
        repoOf({
          getOneBy: () =>
            Effect.suspend(() => {
              const ticket = available;
              available = undefined;
              return ticket === undefined ? Effect.fail(new TicketNotFound()) : Effect.succeed(ticket);
            }),
          save: () => Effect.void,
        }),
        HarnessSelectorNoop,
        capturingImplementation(emitted)
      );
      const fiber = yield* runEngine({ project }).pipe(
        Effect.provide(layer),
        Effect.forkChild({ startImmediately: true })
      );

      yield* TestClock.adjust('239 seconds');
      available = sampleTicket(1);
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
        repoOf({
          getOneBy: ticketsThenGone([]),
          save: () => Effect.void,
        }),
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
        repoOf({
          getOneBy: ticketsThenGone([sampleTicket(1)]),
          save: () => Effect.void,
        }),
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
        repoOf({
          getOneBy: ticketsThenGone([ticket]),
          save: () => Effect.void,
        }),
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
          repoOf({
            getOneBy: ticketsThenGone([sampleTicket(1)]),
            save: (ticket) =>
              Effect.sync(() => {
                claimed.push(ticket);
              }),
          }),
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
