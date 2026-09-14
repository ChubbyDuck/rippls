import { Effect, Layer, Result, Schema } from 'effect';
import { expect, test } from 'vitest';

import { RunnerId } from '~/Core/Shared/Domain/Properties/RunnerId';
import type { Agent } from '~/Core/Shared/Ports/Agent';
import { AgentRepository } from '~/Core/Shared/Ports/AgentRepository';
import { Ticket } from '~/Core/Tickets/Domain/Entities/Ticket/entity';
import { formatTicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';
import { HarnessHalted } from '~/Core/Tickets/Domain/Exceptions/HarnessHalted';
import { StrategyNotFound } from '~/Core/Tickets/Domain/Exceptions/StrategyNotFound';
import { StrategyRuntimeError } from '~/Core/Tickets/Domain/Exceptions/StrategyRuntimeError';
import { TicketNotFound } from '~/Core/Tickets/Domain/Exceptions/TicketNotFound';
import { WorktreeCloseError } from '~/Core/Tickets/Domain/Exceptions/WorktreeCloseError';
import { WorktreeCreationError } from '~/Core/Tickets/Domain/Exceptions/WorktreeCreationError';
import { StrategyRepository } from '~/Core/Tickets/Ports/StrategyRepository';
import { TicketRepository } from '~/Core/Tickets/Ports/TicketRepository';
import { WorktreeRepository } from '~/Core/Tickets/Ports/WorktreeRepository';

import { processTicket } from './processTicket';

const ticket = Ticket.create({
  id: formatTicketId('folder', '1'),
  title: 'Process a ticket',
  project: 'test',
  kind: 'implementation',
  status: 'ready-for-agent',
  blockedBy: [],
  blocks: [],
  body: 'Ticket instructions',
});
const runnerId = Schema.decodeSync(RunnerId)('standalone');
const repositoryRoot = '/repo';
const projectWorktree = { path: '/repo/.sandcastle/worktrees/test', branch: 'test' };
const ticketWorktreeOf = (id: string) => ({
  path: `/repo/.sandcastle/worktrees/ticket-${id}`,
  branch: `ticket-${id}`,
});
const recordingWorktrees = (closed: string[] = []) =>
  Layer.succeed(WorktreeRepository, {
    projectAnchor: () => Effect.succeed(projectWorktree),
    ticketAnchor: ({ id }) => Effect.succeed(ticketWorktreeOf(id)),
    close: (worktree) =>
      Effect.sync(() => {
        closed.push(worktree.path);
      }),
  });
const WorktreeRepositoryNoop = recordingWorktrees();

test('processTicket can be reused independently with the services supplied by each caller', () => {
  const work = processTicket({ ticket, runnerId, repositoryRoot });

  for (const name of ['first-agent', 'second-agent']) {
    const events: string[] = [];
    const saved: Ticket[] = [];
    const agent: Agent = {
      name,
      model: 'test-model',
      run: () => Effect.succeed({ completionSignal: undefined }),
    };
    const services = Layer.mergeAll(
      Layer.succeed(AgentRepository, {
        getOne: Effect.sync(() => {
          events.push('select agent');
          return agent;
        }),
      }),
      Layer.succeed(TicketRepository, {
        getOneBy: () => Effect.succeed(ticket.claim({ by: runnerId })),
        getManyBy: () => Effect.succeed([]),
        save: (value) =>
          Effect.sync(() => {
            events.push(`save ${value.status}`);
            saved.push(value);
          }),
        saveMany: (values) =>
          Effect.sync(() => {
            for (const value of values) {
              events.push(`save ${value.status}`);
              saved.push(value);
            }
          }),
      }),
      Layer.succeed(StrategyRepository, {
        getOneBy: (kind) =>
          Effect.sync(() => {
            events.push(`select ${kind}`);
            return {
              name: 'implementation',
              run: (claimed, selectedAgent) =>
                Effect.sync(() => {
                  expect(claimed).toEqual(ticket.claim({ by: runnerId }));
                  expect(selectedAgent.name).toBe(agent.name);
                  events.push('run strategy');
                  return Result.succeed(undefined);
                }),
            };
          }),
      }),
      WorktreeRepositoryNoop
    );

    expect(Effect.runSync(work.pipe(Effect.provide(services)))).toBeUndefined();
    expect(events).toEqual(['select agent', 'save claimed', 'select implementation', 'run strategy', 'save done']);
    expect(saved).toEqual([ticket.claim({ by: runnerId }), ticket.claim({ by: runnerId }).done()]);
    expect(ticket.status).toBe('ready-for-agent');
    expect(ticket.claimedBy).toBeUndefined();
  }
});

test('processTicket runs a ticket that omits project', () => {
  const withoutProject = Ticket.create({
    id: formatTicketId('folder', '1'),
    title: 'Process a ticket',
    kind: 'implementation',
    status: 'ready-for-agent',
    blockedBy: [],
    blocks: [],
    body: 'Ticket instructions',
  });
  const saved: Ticket[] = [];
  const services = Layer.mergeAll(
    Layer.succeed(AgentRepository, {
      getOne: Effect.succeed({
        name: 'test-agent',
        model: 'test-model',
        run: () => Effect.succeed({ completionSignal: undefined }),
      }),
    }),
    Layer.succeed(TicketRepository, {
      getOneBy: () => Effect.succeed(withoutProject.claim({ by: runnerId })),
      getManyBy: () => Effect.succeed([]),
      save: (value) =>
        Effect.sync(() => {
          saved.push(value);
        }),
      saveMany: () => Effect.void,
    }),
    Layer.succeed(StrategyRepository, {
      getOneBy: () =>
        Effect.succeed({
          name: 'implementation',
          run: () => Effect.succeed(Result.succeed(undefined)),
        }),
    }),
    WorktreeRepositoryNoop
  );

  expect(
    Effect.runSync(processTicket({ ticket: withoutProject, runnerId, repositoryRoot }).pipe(Effect.provide(services)))
  ).toBeUndefined();
  expect(saved.map((value) => value.project)).toEqual([undefined, undefined]);
});

test('processTicket escalates the ticket and halts the run when the strategy fails', () => {
  const saved: Ticket[] = [];
  const agent: Agent = {
    name: 'test-agent',
    model: 'test-model',
    run: () => Effect.succeed({ completionSignal: undefined }),
  };
  const services = Layer.mergeAll(
    Layer.succeed(AgentRepository, {
      getOne: Effect.succeed(agent),
    }),
    Layer.succeed(TicketRepository, {
      getOneBy: () => Effect.succeed(ticket.claim({ by: runnerId })),
      getManyBy: () => Effect.succeed([]),
      save: (value) =>
        Effect.sync(() => {
          saved.push(value);
        }),
      saveMany: (values) =>
        Effect.sync(() => {
          saved.push(...values);
        }),
    }),
    Layer.succeed(StrategyRepository, {
      getOneBy: () =>
        Effect.succeed({
          name: 'implementation',
          run: () => Effect.succeed(Result.fail(new StrategyRuntimeError())),
        }),
    }),
    WorktreeRepositoryNoop
  );

  const halt = Effect.runSync(
    processTicket({ ticket, runnerId, repositoryRoot }).pipe(Effect.provide(services), Effect.flip)
  );

  expect(halt).toBeInstanceOf(HarnessHalted);
  expect(saved).toEqual([ticket.claim({ by: runnerId }), ticket.escalate()]);
});

test('processTicket propagates a missing strategy and does not mark the ticket done', () => {
  const saved: Ticket[] = [];
  const failure = new StrategyNotFound({ kind: ticket.kind });
  const agent: Agent = {
    name: 'test-agent',
    model: 'test-model',
    run: () => Effect.succeed({ completionSignal: undefined }),
  };
  const services = Layer.mergeAll(
    Layer.succeed(AgentRepository, {
      getOne: Effect.succeed(agent),
    }),
    Layer.succeed(TicketRepository, {
      getOneBy: () => Effect.fail(new TicketNotFound()),
      getManyBy: () => Effect.succeed([]),
      save: (value) =>
        Effect.sync(() => {
          saved.push(value);
        }),
      saveMany: (values) =>
        Effect.sync(() => {
          saved.push(...values);
        }),
    }),
    Layer.succeed(StrategyRepository, {
      getOneBy: () => Effect.fail(failure),
    }),
    WorktreeRepositoryNoop
  );

  expect(
    Effect.runSync(processTicket({ ticket, runnerId, repositoryRoot }).pipe(Effect.provide(services), Effect.flip))
  ).toBe(failure);
  expect(saved).toEqual([ticket.claim({ by: runnerId })]);
});

const agentRecordingCwd = (cwds: Array<string | undefined>): Agent => ({
  name: 'test-agent',
  model: 'test-model',
  run: (_prompt, options) =>
    Effect.sync(() => {
      cwds.push(options.cwd);
      return { completionSignal: undefined };
    }),
});

const probingStrategy = Layer.succeed(StrategyRepository, {
  getOneBy: () =>
    Effect.succeed({
      name: 'implementation',
      run: (_claimed, selectedAgent) =>
        selectedAgent.run('probe', { label: 'probe' }).pipe(Effect.orDie, Effect.as(Result.succeed(undefined))),
    }),
});

const ticketRepoIgnoringReads = Layer.succeed(TicketRepository, {
  getOneBy: () => Effect.succeed(ticket.claim({ by: runnerId })),
  getManyBy: () => Effect.succeed([]),
  save: () => Effect.void,
  saveMany: () => Effect.void,
});

test('processTicket hands the strategy an agent anchored at the ticket worktree', () => {
  const cwds: Array<string | undefined> = [];
  const withoutProject = Ticket.create({
    id: formatTicketId('folder', '1'),
    title: 'Process a ticket',
    kind: 'implementation',
    status: 'ready-for-agent',
    blockedBy: [],
    blocks: [],
    body: 'Ticket instructions',
  });
  const agent = agentRecordingCwd(cwds);
  const services = Layer.mergeAll(
    Layer.succeed(AgentRepository, {
      getOne: Effect.succeed(agent),
    }),
    Layer.succeed(TicketRepository, {
      getOneBy: () => Effect.succeed(withoutProject.claim({ by: runnerId })),
      getManyBy: () => Effect.succeed([]),
      save: () => Effect.void,
      saveMany: () => Effect.void,
    }),
    probingStrategy,
    WorktreeRepositoryNoop
  );

  Effect.runSync(processTicket({ ticket: withoutProject, runnerId, repositoryRoot }).pipe(Effect.provide(services)));

  expect(cwds).toEqual(['/repo/.sandcastle/worktrees/ticket-folder:1']);
});

test('processTicket hands the strategy an agent anchored at the ticket worktree of a project ticket', () => {
  const cwds: Array<string | undefined> = [];
  const agent = agentRecordingCwd(cwds);
  const services = Layer.mergeAll(
    Layer.succeed(AgentRepository, {
      getOne: Effect.succeed(agent),
    }),
    ticketRepoIgnoringReads,
    probingStrategy,
    WorktreeRepositoryNoop
  );

  Effect.runSync(processTicket({ ticket, runnerId, repositoryRoot }).pipe(Effect.provide(services)));

  expect(cwds).toEqual(['/repo/.sandcastle/worktrees/ticket-folder:1']);
});

test('two tickets that name the same project run in distinct ticket worktrees', () => {
  const cwds: Array<string | undefined> = [];
  const first = ticket;
  const second = Ticket.create({
    id: formatTicketId('folder', '2'),
    title: 'Process another ticket',
    project: 'test',
    kind: 'implementation',
    status: 'ready-for-agent',
    blockedBy: [],
    blocks: [],
    body: 'Ticket instructions',
  });
  const agent = agentRecordingCwd(cwds);
  const store = new Map();
  const services = Layer.mergeAll(
    Layer.succeed(AgentRepository, {
      getOne: Effect.succeed(agent),
    }),
    Layer.succeed(TicketRepository, {
      getOneBy: (query) => {
        const found = query.id === undefined ? undefined : store.get(query.id);
        return found === undefined ? Effect.fail(new TicketNotFound()) : Effect.succeed(found);
      },
      getManyBy: () => Effect.succeed([]),
      save: (value) =>
        Effect.sync(() => {
          store.set(value.id, value);
        }),
      saveMany: () => Effect.void,
    }),
    probingStrategy,
    recordingWorktrees()
  );

  Effect.runSync(processTicket({ ticket: first, runnerId, repositoryRoot }).pipe(Effect.provide(services)));
  Effect.runSync(processTicket({ ticket: second, runnerId, repositoryRoot }).pipe(Effect.provide(services)));

  expect(cwds).toEqual(['/repo/.sandcastle/worktrees/ticket-folder:1', '/repo/.sandcastle/worktrees/ticket-folder:2']);
});

test('processTicket closes the ticket worktree after a successful strategy', () => {
  const closed: string[] = [];
  const services = Layer.mergeAll(
    Layer.succeed(AgentRepository, {
      getOne: Effect.succeed({
        name: 'test-agent',
        model: 'test-model',
        run: () => Effect.succeed({ completionSignal: undefined }),
      }),
    }),
    ticketRepoIgnoringReads,
    Layer.succeed(StrategyRepository, {
      getOneBy: () =>
        Effect.succeed({
          name: 'implementation',
          run: () => Effect.succeed(Result.succeed(undefined)),
        }),
    }),
    recordingWorktrees(closed)
  );

  Effect.runSync(processTicket({ ticket, runnerId, repositoryRoot }).pipe(Effect.provide(services)));

  expect(closed).toEqual(['/repo/.sandcastle/worktrees/ticket-folder:1']);
});

test('processTicket retains the ticket worktree when the strategy fails', () => {
  const closed: string[] = [];
  const services = Layer.mergeAll(
    Layer.succeed(AgentRepository, {
      getOne: Effect.succeed({
        name: 'test-agent',
        model: 'test-model',
        run: () => Effect.succeed({ completionSignal: undefined }),
      }),
    }),
    ticketRepoIgnoringReads,
    Layer.succeed(StrategyRepository, {
      getOneBy: () =>
        Effect.succeed({
          name: 'implementation',
          run: () => Effect.succeed(Result.fail(new StrategyRuntimeError())),
        }),
    }),
    recordingWorktrees(closed)
  );

  Effect.runSync(processTicket({ ticket, runnerId, repositoryRoot }).pipe(Effect.provide(services), Effect.flip));

  expect(closed).toEqual([]);
});

test('a project-worktree create failure is retried once and then halts without escalating the ticket', () => {
  const saved: Ticket[] = [];
  let attempts = 0;
  const services = Layer.mergeAll(
    Layer.succeed(AgentRepository, {
      getOne: Effect.succeed({
        name: 'test-agent',
        model: 'test-model',
        run: () => Effect.succeed({ completionSignal: undefined }),
      }),
    }),
    Layer.succeed(TicketRepository, {
      getOneBy: () => Effect.succeed(ticket.claim({ by: runnerId })),
      getManyBy: () => Effect.succeed([]),
      save: (value) =>
        Effect.sync(() => {
          saved.push(value);
        }),
      saveMany: () => Effect.void,
    }),
    Layer.succeed(StrategyRepository, {
      getOneBy: () =>
        Effect.succeed({
          name: 'implementation',
          run: () => Effect.succeed(Result.succeed(undefined)),
        }),
    }),
    Layer.succeed(WorktreeRepository, {
      projectAnchor: () => {
        attempts += 1;
        return Effect.fail(new WorktreeCreationError());
      },
      ticketAnchor: () => Effect.die('ticketAnchor should not be called'),
      close: () => Effect.die('close should not be called'),
    })
  );

  const halt = Effect.runSync(
    processTicket({ ticket, runnerId, repositoryRoot }).pipe(Effect.provide(services), Effect.flip)
  );

  expect(halt).toBeInstanceOf(HarnessHalted);
  expect(attempts).toBe(2);
  expect(saved).toEqual([ticket.claim({ by: runnerId })]);
});

test('a project-worktree create failure that succeeds on retry processes the ticket', () => {
  const cwds: Array<string | undefined> = [];
  let attempts = 0;
  const agent = agentRecordingCwd(cwds);
  const services = Layer.mergeAll(
    Layer.succeed(AgentRepository, {
      getOne: Effect.succeed(agent),
    }),
    ticketRepoIgnoringReads,
    probingStrategy,
    Layer.succeed(WorktreeRepository, {
      projectAnchor: () => {
        attempts += 1;
        return attempts === 1 ? Effect.fail(new WorktreeCreationError()) : Effect.succeed(projectWorktree);
      },
      ticketAnchor: ({ id }) => Effect.succeed(ticketWorktreeOf(id)),
      close: () => Effect.void,
    })
  );

  Effect.runSync(processTicket({ ticket, runnerId, repositoryRoot }).pipe(Effect.provide(services)));

  expect(attempts).toBe(2);
  expect(cwds).toEqual(['/repo/.sandcastle/worktrees/ticket-folder:1']);
});

test('a ticket-worktree close failure is retried once and then halts without escalating the ticket', () => {
  const saved: Ticket[] = [];
  let attempts = 0;
  const services = Layer.mergeAll(
    Layer.succeed(AgentRepository, {
      getOne: Effect.succeed({
        name: 'test-agent',
        model: 'test-model',
        run: () => Effect.succeed({ completionSignal: undefined }),
      }),
    }),
    Layer.succeed(TicketRepository, {
      getOneBy: () => Effect.succeed(ticket.claim({ by: runnerId })),
      getManyBy: () => Effect.succeed([]),
      save: (value) =>
        Effect.sync(() => {
          saved.push(value);
        }),
      saveMany: () => Effect.void,
    }),
    Layer.succeed(StrategyRepository, {
      getOneBy: () =>
        Effect.succeed({
          name: 'implementation',
          run: () => Effect.succeed(Result.succeed(undefined)),
        }),
    }),
    Layer.succeed(WorktreeRepository, {
      projectAnchor: () => Effect.succeed(projectWorktree),
      ticketAnchor: ({ id }) => Effect.succeed(ticketWorktreeOf(id)),
      close: () => {
        attempts += 1;
        return Effect.fail(new WorktreeCloseError());
      },
    })
  );

  const halt = Effect.runSync(
    processTicket({ ticket, runnerId, repositoryRoot }).pipe(Effect.provide(services), Effect.flip)
  );

  expect(halt).toBeInstanceOf(HarnessHalted);
  expect(attempts).toBe(2);
  expect(saved).toEqual([ticket.claim({ by: runnerId })]);
});
