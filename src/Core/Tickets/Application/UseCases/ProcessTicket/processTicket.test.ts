import { Console, Effect, Layer, Result, Schema } from 'effect';
import { expect, test } from 'vitest';

import { EngineId } from '~/Core/Shared/Domain/Properties/EngineId';
import { RunnerId } from '~/Core/Shared/Domain/Properties/RunnerId';
import type { Harness } from '~/Core/Shared/Ports/Harness';
import { HarnessSelector } from '~/Core/Shared/Ports/HarnessSelector';
import { Claim } from '~/Core/Tickets/Domain/Entities/Claim/entity';
import { Escalation } from '~/Core/Tickets/Domain/Entities/Escalation/entity';
import { Ticket } from '~/Core/Tickets/Domain/Entities/Ticket/entity';
import { formatTicketId, type TicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';
import type { TicketEvent } from '~/Core/Tickets/Domain/Events/TicketEvent';
import { EngineHalted } from '~/Core/Tickets/Domain/Exceptions/EngineHalted';
import { StrategyNotFound } from '~/Core/Tickets/Domain/Exceptions/StrategyNotFound';
import { StrategyRuntimeError } from '~/Core/Tickets/Domain/Exceptions/StrategyRuntimeError';
import { TicketEventNotReported } from '~/Core/Tickets/Domain/Exceptions/TicketEventNotReported';
import { TicketNotFound } from '~/Core/Tickets/Domain/Exceptions/TicketNotFound';
import { WorktreeCloseError } from '~/Core/Tickets/Domain/Exceptions/WorktreeCloseError';
import { WorktreeCreationError } from '~/Core/Tickets/Domain/Exceptions/WorktreeCreationError';
import { WorktreeNotExpected } from '~/Core/Tickets/Domain/Exceptions/WorktreeNotExpected';
import { StrategySelector } from '~/Core/Tickets/Ports/StrategySelector';
import { TicketSource } from '~/Core/Tickets/Ports/TicketSource';
import { WorktreeManager } from '~/Core/Tickets/Ports/WorktreeManager';
import { makeLedgerMemory } from '~/Infrastructure/Tickets/Ledger/memory';

import { processTicket } from './processTicket';

const ticketFields = {
  id: formatTicketId('folder', '1'),
  title: 'Process a ticket',
  project: 'test',
  kind: 'implementation',
  blockedBy: [],
  body: 'Ticket instructions',
} as const;
const ticket = Ticket.create(ticketFields);
const engine = Schema.decodeSync(EngineId)('standalone');
const runnerId = Schema.decodeSync(RunnerId)('standalone:0');
const repositoryRoot = '/repo';
const projectWorktree = { path: '/repo/.sandcastle/worktrees/test', branch: 'test' };
// As the Worktree Manager does, the fake names the branch of a Ticket Worktree
// from the ticket identity with the characters unsafe in a branch name replaced.
const ticketWorktreeOf = (id: string) => {
  const branch = `ticket-${id.replace(/[^A-Za-z0-9_-]/g, '-')}`;
  return { path: `/repo/.sandcastle/worktrees/${branch}`, branch };
};
const recordingWorktrees = (closed: string[] = []) =>
  Layer.succeed(WorktreeManager, {
    prepareProject: () => Effect.succeed(projectWorktree),
    prepareTicket: ({ id }) => Effect.succeed(ticketWorktreeOf(id)),
    runCommand: () => Effect.die('runCommand should not be called'),
    isClean: () => Effect.succeed(true),
    mergeAndClose: (worktree) =>
      Effect.sync(() => {
        closed.push(worktree.path);
      }),
  });
const WorktreeManagerNoop = recordingWorktrees();

// processTicket starts on a ticket that the Engine has claimed in the Ledger.
const ledgerClaiming = (...tickets: readonly Ticket[]) => {
  const ledger = makeLedgerMemory();
  for (const claimed of tickets) {
    ledger.claims.set(claimed.id, new Claim({ ticket: claimed.id, engine, process: 1, host: 'memory' }));
  }
  return ledger;
};
const secondTicketId = formatTicketId('folder', '2');
const withClaims = <A, E, R>(services: Layer.Layer<A, E, R>) =>
  Layer.merge(
    services,
    ledgerClaiming(ticket, Ticket.create({ ...ticketFields, id: secondTicketId })).layer
  );

test('processTicket can be reused independently with the services supplied by each caller', () => {
  const work = processTicket({ ticket, runnerId, repositoryRoot });

  for (const name of ['first-harness', 'second-harness']) {
    const events: string[] = [];
    const doneReported: TicketId[] = [];
    const harness: Harness = {
      name,
      model: 'test-model',
      run: () => Effect.succeed({ completionSignal: undefined }),
    };
    const services = Layer.mergeAll(
      Layer.succeed(HarnessSelector, {
        select: Effect.sync(() => {
          events.push('select harness');
          return harness;
        }),
      }),
      Layer.succeed(TicketSource, {
        getOneBy: () => Effect.succeed(ticket),
        getUnreadable: Effect.succeed([]),
        getManyBy: () => Effect.succeed([]),
        reportDone: (id) =>
          Effect.sync(() => {
            events.push('report done');
            doneReported.push(id);
            return Effect.void;
          }),
        report: () => Effect.void,
      }),
      Layer.succeed(StrategySelector, {
        select: (kind) =>
          Effect.sync(() => {
            events.push(`select ${kind}`);
            return {
              name: 'implementation',
              run: (claimed, selectedHarness) =>
                Effect.sync(() => {
                  expect(claimed).toEqual(ticket);
                  expect(selectedHarness.name).toBe(harness.name);
                  events.push('run strategy');
                  return Result.succeed(undefined);
                }),
            };
          }),
      }),
      WorktreeManagerNoop
    );

    expect(Effect.runSync(work.pipe(Effect.provide(withClaims(services))))).toBeUndefined();
    expect(events).toEqual(['select harness', 'select implementation', 'run strategy', 'report done']);
    expect(doneReported).toEqual([ticket.id]);
    expect(ticket.doneInSource).toBe(false);
  }
});

test('processTicket runs a ticket that omits project', () => {
  const withoutProject = Ticket.create({
    id: formatTicketId('folder', '1'),
    title: 'Process a ticket',
    kind: 'implementation',
    blockedBy: [],
    body: 'Ticket instructions',
  });
  const doneReported: TicketId[] = [];
  const services = Layer.mergeAll(
    Layer.succeed(HarnessSelector, {
      select: Effect.succeed({
        name: 'test-harness',
        model: 'test-model',
        run: () => Effect.succeed({ completionSignal: undefined }),
      }),
    }),
    Layer.succeed(TicketSource, {
      getOneBy: () => Effect.succeed(withoutProject),
      getUnreadable: Effect.succeed([]),
      getManyBy: () => Effect.succeed([]),
      reportDone: (id) =>
        Effect.sync(() => {
          doneReported.push(id);
          return Effect.void;
        }),
      report: () => Effect.void,
    }),
    Layer.succeed(StrategySelector, {
      select: () =>
        Effect.succeed({
          name: 'implementation',
          run: () => Effect.succeed(Result.succeed(undefined)),
        }),
    }),
    WorktreeManagerNoop
  );

  expect(
    Effect.runSync(processTicket({ ticket: withoutProject, runnerId, repositoryRoot }).pipe(Effect.provide(withClaims(services))))
  ).toBeUndefined();
  expect(doneReported).toEqual([withoutProject.id]);
});

const failingServices = (
  doneReported: TicketId[],
  report: (ticket: TicketId, event: TicketEvent) => Effect.Effect<void, TicketEventNotReported> = () => Effect.void
) =>
  Layer.mergeAll(
    Layer.succeed(HarnessSelector, {
      select: Effect.succeed({
        name: 'test-harness',
        model: 'test-model',
        run: () => Effect.succeed({ completionSignal: undefined }),
      }),
    }),
    Layer.succeed(TicketSource, {
      getOneBy: () => Effect.succeed(ticket),
      getUnreadable: Effect.succeed([]),
      getManyBy: () => Effect.succeed([]),
      reportDone: (id) =>
        Effect.sync(() => {
          doneReported.push(id);
          return Effect.void;
        }),
      report,
    }),
    Layer.succeed(StrategySelector, {
      select: () =>
        Effect.succeed({
          name: 'implementation',
          run: () => Effect.succeed(Result.fail(new StrategyRuntimeError({ step: 2, failure: 'verdict other than pass' }))),
        }),
    }),
    WorktreeManagerNoop
  );

test('processTicket escalates the ticket in the Ledger with the failed step as the reason, and halts the run when the strategy fails', () => {
  const doneReported: TicketId[] = [];
  const reported: TicketEvent[] = [];
  const ledger = ledgerClaiming(ticket);
  const services = failingServices(doneReported, (_, event) =>
    Effect.sync(() => {
      reported.push(event);
    })
  );

  const halt = Effect.runSync(
    processTicket({ ticket, runnerId, repositoryRoot }).pipe(
      Effect.provide(Layer.merge(services, ledger.layer)),
      Effect.flip
    )
  );

  const reason = 'strategy failure: step 2, verdict other than pass';
  expect(halt).toEqual(new EngineHalted({ ticketId: ticket.id, reason }));
  expect(doneReported).toEqual([]);
  expect(reported).toEqual(['escalated']);
  expect(ledger.claims.size).toBe(0);
  expect(ledger.escalated.get(ticket.id)).toEqual(
    new Escalation({ ticket: ticket.id, reason, attempts: 1, worktree: ticketWorktreeOf(ticket.id).path })
  );
});

test('processTicket keeps the escalation and the Claim, logs the failed report, and halts when the Source cannot report it', () => {
  const ledger = ledgerClaiming(ticket);
  const errors: string[] = [];
  const capturing: Console.Console = Object.assign(Object.create(console), {
    error: (...args: ReadonlyArray<unknown>) => {
      errors.push(args.map(String).join(' '));
    },
  });
  const services = failingServices([], (failed, event) =>
    Effect.fail(new TicketEventNotReported({ ticketId: failed, event }))
  );

  const halt = Effect.runSync(
    processTicket({ ticket, runnerId, repositoryRoot }).pipe(
      Effect.provide(Layer.mergeAll(services, ledger.layer, Layer.succeed(Console.Console, capturing))),
      Effect.flip
    )
  );

  expect(halt).toBeInstanceOf(EngineHalted);
  expect(ledger.escalated.has(ticket.id)).toBe(true);
  expect(ledger.claims.has(ticket.id)).toBe(true);
  expect(errors).toContain(
    `Failed to report the escalation of ticket ${ticket.id}, so its Claim stays in the Ledger TicketEventNotReported`
  );
});

test('processTicket propagates a missing strategy and does not mark the ticket done', () => {
  const doneReported: TicketId[] = [];
  const failure = new StrategyNotFound({ kind: ticket.kind });
  const harness: Harness = {
    name: 'test-harness',
    model: 'test-model',
    run: () => Effect.succeed({ completionSignal: undefined }),
  };
  const services = Layer.mergeAll(
    Layer.succeed(HarnessSelector, {
      select: Effect.succeed(harness),
    }),
    Layer.succeed(TicketSource, {
      getOneBy: () => Effect.fail(new TicketNotFound()),
      getUnreadable: Effect.succeed([]),
      getManyBy: () => Effect.succeed([]),
      reportDone: (id) =>
        Effect.sync(() => {
          doneReported.push(id);
          return Effect.void;
        }),
      report: () => Effect.void,
    }),
    Layer.succeed(StrategySelector, {
      select: () => Effect.fail(failure),
    }),
    WorktreeManagerNoop
  );

  expect(
    Effect.runSync(processTicket({ ticket, runnerId, repositoryRoot }).pipe(Effect.provide(withClaims(services)), Effect.flip))
  ).toBe(failure);
  expect(doneReported).toEqual([]);
});

const harnessRecordingCwd = (cwds: Array<string | undefined>): Harness => ({
  name: 'test-harness',
  model: 'test-model',
  run: (_prompt, options) =>
    Effect.sync(() => {
      cwds.push(options.cwd);
      return { completionSignal: undefined };
    }),
});

const probingStrategy = Layer.succeed(StrategySelector, {
  select: () =>
    Effect.succeed({
      name: 'implementation',
      run: (_claimed, selectedHarness) =>
        selectedHarness.run('probe', { label: 'probe' }).pipe(Effect.orDie, Effect.as(Result.succeed(undefined))),
    }),
});

const ticketRepoIgnoringReads = Layer.succeed(TicketSource, {
  getOneBy: () => Effect.succeed(ticket),
  getUnreadable: Effect.succeed([]),
  getManyBy: () => Effect.succeed([]),
  reportDone: () => Effect.succeed(Effect.void),
  report: () => Effect.void,
});

test('processTicket hands the strategy a harness bound to the ticket worktree', () => {
  const cwds: Array<string | undefined> = [];
  const withoutProject = Ticket.create({
    id: formatTicketId('folder', '1'),
    title: 'Process a ticket',
    kind: 'implementation',
    blockedBy: [],
    body: 'Ticket instructions',
  });
  const harness = harnessRecordingCwd(cwds);
  const services = Layer.mergeAll(
    Layer.succeed(HarnessSelector, {
      select: Effect.succeed(harness),
    }),
    Layer.succeed(TicketSource, {
      getOneBy: () => Effect.succeed(withoutProject),
      getUnreadable: Effect.succeed([]),
      getManyBy: () => Effect.succeed([]),
      reportDone: () => Effect.succeed(Effect.void),
      report: () => Effect.void,
    }),
    probingStrategy,
    WorktreeManagerNoop
  );

  Effect.runSync(processTicket({ ticket: withoutProject, runnerId, repositoryRoot }).pipe(Effect.provide(withClaims(services))));

  expect(cwds).toEqual(['/repo/.sandcastle/worktrees/ticket-folder-1']);
});

test('processTicket hands the strategy a harness bound to the ticket worktree of a project ticket', () => {
  const cwds: Array<string | undefined> = [];
  const harness = harnessRecordingCwd(cwds);
  const services = Layer.mergeAll(
    Layer.succeed(HarnessSelector, {
      select: Effect.succeed(harness),
    }),
    ticketRepoIgnoringReads,
    probingStrategy,
    WorktreeManagerNoop
  );

  Effect.runSync(processTicket({ ticket, runnerId, repositoryRoot }).pipe(Effect.provide(withClaims(services))));

  expect(cwds).toEqual(['/repo/.sandcastle/worktrees/ticket-folder-1']);
});

test('two tickets that name the same project run in distinct ticket worktrees', () => {
  const cwds: Array<string | undefined> = [];
  const first = ticket;
  const second = Ticket.create({
    id: formatTicketId('folder', '2'),
    title: 'Process another ticket',
    project: 'test',
    kind: 'implementation',
    blockedBy: [],
    body: 'Ticket instructions',
  });
  const harness = harnessRecordingCwd(cwds);
  const store = new Map([first, second].map((value) => [value.id, value]));
  const services = Layer.mergeAll(
    Layer.succeed(HarnessSelector, {
      select: Effect.succeed(harness),
    }),
    Layer.succeed(TicketSource, {
      getOneBy: (query) => {
        const found = query.id === undefined ? undefined : store.get(query.id);
        return found === undefined ? Effect.fail(new TicketNotFound()) : Effect.succeed(found);
      },
      getUnreadable: Effect.succeed([]),
      getManyBy: () => Effect.succeed([]),
      reportDone: () => Effect.succeed(Effect.void),
      report: () => Effect.void,
    }),
    probingStrategy,
    recordingWorktrees()
  );

  Effect.runSync(processTicket({ ticket: first, runnerId, repositoryRoot }).pipe(Effect.provide(withClaims(services))));
  Effect.runSync(processTicket({ ticket: second, runnerId, repositoryRoot }).pipe(Effect.provide(withClaims(services))));

  expect(cwds).toEqual(['/repo/.sandcastle/worktrees/ticket-folder-1', '/repo/.sandcastle/worktrees/ticket-folder-2']);
});

test('processTicket closes the ticket worktree after a successful strategy', () => {
  const closed: string[] = [];
  const services = Layer.mergeAll(
    Layer.succeed(HarnessSelector, {
      select: Effect.succeed({
        name: 'test-harness',
        model: 'test-model',
        run: () => Effect.succeed({ completionSignal: undefined }),
      }),
    }),
    ticketRepoIgnoringReads,
    Layer.succeed(StrategySelector, {
      select: () =>
        Effect.succeed({
          name: 'implementation',
          run: () => Effect.succeed(Result.succeed(undefined)),
        }),
    }),
    recordingWorktrees(closed)
  );

  Effect.runSync(processTicket({ ticket, runnerId, repositoryRoot }).pipe(Effect.provide(withClaims(services))));

  expect(closed).toEqual(['/repo/.sandcastle/worktrees/ticket-folder-1']);
});

test('processTicket retains the ticket worktree when the strategy fails', () => {
  const closed: string[] = [];
  const services = Layer.mergeAll(
    Layer.succeed(HarnessSelector, {
      select: Effect.succeed({
        name: 'test-harness',
        model: 'test-model',
        run: () => Effect.succeed({ completionSignal: undefined }),
      }),
    }),
    ticketRepoIgnoringReads,
    Layer.succeed(StrategySelector, {
      select: () =>
        Effect.succeed({
          name: 'implementation',
          run: () => Effect.succeed(Result.fail(new StrategyRuntimeError({ step: 2, failure: 'verdict other than pass' }))),
        }),
    }),
    recordingWorktrees(closed)
  );

  Effect.runSync(processTicket({ ticket, runnerId, repositoryRoot }).pipe(Effect.provide(withClaims(services)), Effect.flip));

  expect(closed).toEqual([]);
});

test('a project-worktree create failure is retried once and then halts without escalating the ticket', () => {
  const doneReported: TicketId[] = [];
  let attempts = 0;
  const services = Layer.mergeAll(
    Layer.succeed(HarnessSelector, {
      select: Effect.succeed({
        name: 'test-harness',
        model: 'test-model',
        run: () => Effect.succeed({ completionSignal: undefined }),
      }),
    }),
    Layer.succeed(TicketSource, {
      getOneBy: () => Effect.succeed(ticket),
      getUnreadable: Effect.succeed([]),
      getManyBy: () => Effect.succeed([]),
      reportDone: (id) =>
        Effect.sync(() => {
          doneReported.push(id);
          return Effect.void;
        }),
      report: () => Effect.void,
    }),
    Layer.succeed(StrategySelector, {
      select: () =>
        Effect.succeed({
          name: 'implementation',
          run: () => Effect.succeed(Result.succeed(undefined)),
        }),
    }),
    Layer.succeed(WorktreeManager, {
      prepareProject: () => {
        attempts += 1;
        return Effect.fail(new WorktreeCreationError());
      },
      prepareTicket: () => Effect.die('prepareTicket should not be called'),
      runCommand: () => Effect.die('runCommand should not be called'),
      isClean: () => Effect.succeed(true),
      mergeAndClose: () => Effect.die('mergeAndClose should not be called'),
    })
  );

  const halt = Effect.runSync(
    processTicket({ ticket, runnerId, repositoryRoot }).pipe(Effect.provide(withClaims(services)), Effect.flip)
  );

  expect(halt).toBeInstanceOf(EngineHalted);
  expect(attempts).toBe(2);
  expect(doneReported).toEqual([]);
});

test.each([
  { kind: 'Project Worktree', expected: projectWorktree, failing: 'prepareProject' },
  { kind: 'Ticket Worktree', expected: ticketWorktreeOf(ticket.id), failing: 'prepareTicket' },
] as const)(
  'a $kind on disk that is not the expected one halts with what was found, with no second try and no Agent',
  ({ expected, failing }) => {
    const cwds: Array<string | undefined> = [];
    const ledger = ledgerClaiming(ticket);
    let attempts = 0;
    const unexpected = new WorktreeNotExpected({
      path: expected.path,
      expectedBranch: expected.branch,
      found: 'a directory that is not a Git worktree',
    });
    const services = Layer.mergeAll(
      Layer.succeed(HarnessSelector, { select: Effect.succeed(harnessRecordingCwd(cwds)) }),
      ticketRepoIgnoringReads,
      probingStrategy,
      Layer.succeed(WorktreeManager, {
        prepareProject: () => Effect.succeed(projectWorktree),
        prepareTicket: () => Effect.die('prepareTicket should not be called'),
        runCommand: () => Effect.die('runCommand should not be called'),
        isClean: () => Effect.die('isClean should not be called'),
        mergeAndClose: () => Effect.die('mergeAndClose should not be called'),
        [failing]: () =>
          Effect.suspend(() => {
            attempts += 1;
            return Effect.fail(unexpected);
          }),
      })
    );

    const halt = Effect.runSync(
      processTicket({ ticket, runnerId, repositoryRoot }).pipe(Effect.provide(Layer.merge(services, ledger.layer)), Effect.flip)
    );

    expect(halt).toEqual(new EngineHalted({ ticketId: ticket.id, reason: unexpected.message }));
    expect(attempts).toBe(1);
    expect(cwds).toEqual([]);
    expect(ledger.done.size).toBe(0);
    expect(ledger.escalated.size).toBe(0);
  }
);

test('a project-worktree create failure that succeeds on retry processes the ticket', () => {
  const cwds: Array<string | undefined> = [];
  let attempts = 0;
  const harness = harnessRecordingCwd(cwds);
  const services = Layer.mergeAll(
    Layer.succeed(HarnessSelector, {
      select: Effect.succeed(harness),
    }),
    ticketRepoIgnoringReads,
    probingStrategy,
    Layer.succeed(WorktreeManager, {
      prepareProject: () => {
        attempts += 1;
        return attempts === 1 ? Effect.fail(new WorktreeCreationError()) : Effect.succeed(projectWorktree);
      },
      prepareTicket: ({ id }) => Effect.succeed(ticketWorktreeOf(id)),
      runCommand: () => Effect.die('runCommand should not be called'),
      isClean: () => Effect.succeed(true),
      mergeAndClose: () => Effect.void,
    })
  );

  Effect.runSync(processTicket({ ticket, runnerId, repositoryRoot }).pipe(Effect.provide(withClaims(services))));

  expect(attempts).toBe(2);
  expect(cwds).toEqual(['/repo/.sandcastle/worktrees/ticket-folder-1']);
});

test('a ticket-worktree close failure is retried once and then halts with no done in the Ledger and no escalation', () => {
  const doneReported: TicketId[] = [];
  const ledger = ledgerClaiming(ticket);
  let attempts = 0;
  const services = Layer.mergeAll(
    Layer.succeed(HarnessSelector, {
      select: Effect.succeed({
        name: 'test-harness',
        model: 'test-model',
        run: () => Effect.succeed({ completionSignal: undefined }),
      }),
    }),
    Layer.succeed(TicketSource, {
      getOneBy: () => Effect.succeed(ticket),
      getUnreadable: Effect.succeed([]),
      getManyBy: () => Effect.succeed([]),
      reportDone: (id) =>
        Effect.sync(() => {
          doneReported.push(id);
          return Effect.void;
        }),
      report: () => Effect.void,
    }),
    Layer.succeed(StrategySelector, {
      select: () =>
        Effect.succeed({
          name: 'implementation',
          run: () => Effect.succeed(Result.succeed(undefined)),
        }),
    }),
    Layer.succeed(WorktreeManager, {
      prepareProject: () => Effect.succeed(projectWorktree),
      prepareTicket: ({ id }) => Effect.succeed(ticketWorktreeOf(id)),
      runCommand: () => Effect.die('runCommand should not be called'),
      isClean: () => Effect.succeed(true),
      mergeAndClose: () => {
        attempts += 1;
        return Effect.fail(new WorktreeCloseError());
      },
    })
  );

  const halt = Effect.runSync(
    processTicket({ ticket, runnerId, repositoryRoot }).pipe(Effect.provide(Layer.merge(services, ledger.layer)), Effect.flip)
  );

  expect(halt).toBeInstanceOf(EngineHalted);
  expect(attempts).toBe(2);
  expect(doneReported).toEqual([ticket.id]);
  expect(ledger.done.size).toBe(0);
  expect(ledger.escalated.size).toBe(0);
});

const succeedingServices = (strategyRun: () => Effect.Effect<Result.Result<void, StrategyRuntimeError>>) =>
  Layer.mergeAll(
    Layer.succeed(HarnessSelector, {
      select: Effect.succeed({
        name: 'test-harness',
        model: 'test-model',
        run: () => Effect.succeed({ completionSignal: undefined }),
      }),
    }),
    ticketRepoIgnoringReads,
    Layer.succeed(StrategySelector, {
      select: () => Effect.succeed({ name: 'implementation', run: strategyRun }),
    }),
    WorktreeManagerNoop
  );

test('processTicket logs the preparation of a Ticket Worktree with the branch the Worktree Manager returns', () => {
  const inFeatureFolder = Ticket.create({ ...ticketFields, id: formatTicketId('folder', 'auth/1'), project: 'auth' });
  const logged: string[] = [];
  const capturing: Console.Console = Object.assign(Object.create(console), {
    log: (...args: ReadonlyArray<unknown>) => {
      logged.push(args.map(String).join(' '));
    },
  });
  const services = Layer.mergeAll(
    succeedingServices(() => Effect.succeed(Result.succeed(undefined))),
    ledgerClaiming(inFeatureFolder).layer,
    Layer.succeed(Console.Console, capturing)
  );

  Effect.runSync(processTicket({ ticket: inFeatureFolder, runnerId, repositoryRoot }).pipe(Effect.provide(services)));

  expect(logged).toContain('Ticket folder:auth/1 -- implementation prepared worktree ticket-folder-auth-1 from auth');
  expect(logged.filter((line) => line.includes('ticket-folder:auth/1'))).toEqual([]);
});

test('processTicket names its Runner in the Claim and releases the Claim once the ticket is done', () => {
  const ledger = ledgerClaiming(ticket);
  const seen: Array<Claim | undefined> = [];
  const services = succeedingServices(() =>
    Effect.sync(() => {
      seen.push(ledger.claims.get(ticket.id));
      return Result.succeed(undefined);
    })
  );

  Effect.runSync(processTicket({ ticket, runnerId, repositoryRoot }).pipe(Effect.provide(Layer.merge(services, ledger.layer))));

  expect(seen).toEqual([new Claim({ ticket: ticket.id, engine, process: 1, host: 'memory', runner: runnerId })]);
  expect(ledger.claims.has(ticket.id)).toBe(false);
});

test('a done report that fails escalates the ticket, merges nothing, and records no done', () => {
  const ledger = ledgerClaiming(ticket);
  const closed: string[] = [];
  const reported: TicketEvent[] = [];
  const services = Layer.mergeAll(
    Layer.succeed(HarnessSelector, {
      select: Effect.succeed({
        name: 'test-harness',
        model: 'test-model',
        run: () => Effect.succeed({ completionSignal: undefined }),
      }),
    }),
    Layer.succeed(TicketSource, {
      getOneBy: () => Effect.succeed(ticket),
      getUnreadable: Effect.succeed([]),
      getManyBy: () => Effect.succeed([]),
      report: (_, event) =>
        Effect.sync(() => {
          reported.push(event);
        }),
      reportDone: (id) => Effect.fail(new TicketEventNotReported({ ticketId: id, event: 'done' })),
    }),
    Layer.succeed(StrategySelector, {
      select: () => Effect.succeed({ name: 'implementation', run: () => Effect.succeed(Result.succeed(undefined)) }),
    }),
    recordingWorktrees(closed)
  );

  const halt = Effect.runSync(
    processTicket({ ticket, runnerId, repositoryRoot }).pipe(
      Effect.provide(Layer.merge(services, ledger.layer)),
      Effect.flip
    )
  );

  expect(halt).toEqual(new EngineHalted({ ticketId: ticket.id, reason: 'done report failure' }));
  expect(closed).toEqual([]);
  expect(reported).toEqual(['escalated']);
  expect(ledger.done.size).toBe(0);
  expect(ledger.claims.size).toBe(0);
  expect(ledger.escalated.get(ticket.id)?.reason).toBe('done report failure');
});
