import { ConfigProvider, Console, Effect, Fiber, FileSystem, Layer, Option, Path, Result, Schema } from 'effect';
import { expect, test } from 'vitest';

import { EngineId } from '~/Core/Shared/Domain/Properties/EngineId';
import { RepositoryRoot } from '~/Core/Shared/Domain/RepositoryRoot';
import { HarnessSelector } from '~/Core/Shared/Ports/HarnessSelector';
import { pollTicket } from '~/Core/Tickets/Application/UseCases/RunEngine/pollTicket';
import { runEngine } from '~/Core/Tickets/Application/UseCases/RunEngine/runEngine';
import { showStatus, ticketStatuses } from '~/Core/Tickets/Application/UseCases/ShowStatus/showStatus';
import { Claim } from '~/Core/Tickets/Domain/Entities/Claim/entity';
import { Project } from '~/Core/Tickets/Domain/Entities/Ticket/properties/Project';
import type { TicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';
import type { TicketEvent } from '~/Core/Tickets/Domain/Events/TicketEvent';
import { TicketEventNotReported } from '~/Core/Tickets/Domain/Exceptions/TicketEventNotReported';
import type { TicketQuery } from '~/Core/Tickets/Domain/Queries/TicketQuery';
import {
  LinearApi,
  type LinearIssue,
  LinearIssueNotFound,
  type LinearLabel,
  LinearRequestError,
  type LinearMetadata,
} from '~/Core/Tickets/Ports/LinearApi';
import { StrategySelector } from '~/Core/Tickets/Ports/StrategySelector';
import { TicketSource } from '~/Core/Tickets/Ports/TicketSource';
import { WorktreeManager } from '~/Core/Tickets/Ports/WorktreeManager';
import { makeLedgerMemory } from '~/Infrastructure/Tickets/Ledger/memory';
import { toLinearId } from '~/Infrastructure/Tickets/LinearApi/codec';

import { TicketSourceLinearLive } from './linear';

const uuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const toProject = Schema.decodeSync(Project);
const other = 'd4e5f6a7-b8c9-0123-def0-234567890123';

const metadata: LinearMetadata = {
  viewer: { id: 'viewer-1', name: 'Dev' },
  states: [
    { id: 'state-unstarted', name: 'Todo', type: 'unstarted' },
    { id: 'state-started', name: 'In Progress', type: 'started' },
    { id: 'state-completed', name: 'Done', type: 'completed' },
    { id: 'state-backlog', name: 'Backlog', type: 'backlog' },
    { id: 'state-triage', name: 'Triage', type: 'triage' },
    { id: 'state-canceled', name: 'Canceled', type: 'canceled' },
  ],
  labels: [
    { id: 'label-impl', name: 'kind:implementation' },
    { id: 'label-task', name: 'kind:task' },
    { id: 'label-hitl-yes', name: 'hitl:yes' },
    { id: 'label-hitl-no', name: 'hitl:no' },
    { id: 'label-priority', name: 'priority:high' },
    { id: 'label-needs-human', name: 'needs-human' },
  ],
  projects: [{ id: 'proj-1', name: 'Chubby Engine', slugId: 'abc123' }],
};

const issue = (fields: {
  readonly id?: string;
  readonly labels?: readonly LinearLabel[];
  readonly stateType?: string;
  readonly assigneeId?: string | null;
  readonly inverse?: readonly { readonly issueId: string }[];
  readonly createdAt?: string;
  readonly project?: LinearIssue['project'];
}): LinearIssue => ({
  id: fields.id ?? uuid,
  identifier: 'ENG-24',
  title: 'Linear writes',
  description: 'Claim and complete.',
  createdAt: fields.createdAt ?? '2026-01-01T00:00:00.000Z',
  assigneeId: fields.assigneeId === undefined ? null : fields.assigneeId,
  state: metadata.states.find((state) => state.type === (fields.stateType ?? 'unstarted'))!,
  project: fields.project === undefined ? { id: 'proj-1', name: 'Chubby Engine', slugId: 'abc123' } : fields.project,
  labels: fields.labels ?? [{ id: 'label-impl', name: 'kind:implementation' }],
  relations: [],
  inverseRelations: (fields.inverse ?? []).map((relation, index) => ({
    relationId: `in-${index}`,
    issueId: relation.issueId,
    type: 'blocks' as const,
  })),
});

type Mutation =
  | { readonly op: 'setAssignee'; readonly issueId: string; readonly assigneeId: string | null }
  | { readonly op: 'setState'; readonly issueId: string; readonly stateId: string }
  | {
      readonly op: 'setLabels';
      readonly issueId: string;
      readonly addedLabelIds: readonly string[];
      readonly removedLabelIds: readonly string[];
    }
  | { readonly op: 'createRelation'; readonly issueId: string; readonly relatedIssueId: string }
  | { readonly op: 'deleteRelation'; readonly relationId: string };

// A fake Linear API. `labels` replaces the labels of the team, with `failStates`
// every change of a workflow state fails, with `failMetadata` every read of the
// team metadata fails, with `failReadBack` the first read of an Issue after
// each move to a started state fails, and with `failFirstCompletion` the first
// move to a completed state fails.
const fakeLinear = (
  seed: readonly LinearIssue[],
  options: {
    readonly steal?: boolean;
    readonly labels?: readonly LinearLabel[];
    readonly failStates?: boolean;
    readonly failMetadata?: boolean;
    readonly failReadBack?: boolean;
    readonly failFirstCompletion?: boolean;
  } = {}
) => {
  const issues = new Map(seed.map((item) => [item.id, item]));
  const calls: Mutation[] = [];
  let readBackFails = false;
  let completionFails = options.failFirstCompletion === true;
  const team = { ...metadata, labels: options.labels ?? metadata.labels };
  const labelById = new Map(team.labels.map((label) => [label.id, label]));

  const layer = Layer.succeed(LinearApi, {
    metadata: () => (options.failMetadata === true ? Effect.fail(new LinearRequestError()) : Effect.succeed(team)),
    issues: () => Effect.succeed([...issues.values()]),
    issue: (id) =>
      Effect.suspend((): Effect.Effect<LinearIssue, LinearIssueNotFound | LinearRequestError> => {
        if (readBackFails) {
          readBackFails = false;
          return Effect.fail(new LinearRequestError());
        }
        const found = issues.get(id);
        return found === undefined ? Effect.fail(new LinearIssueNotFound()) : Effect.succeed(found);
      }),
    setState: (issueId, stateId) =>
      options.failStates === true || (completionFails && stateId === 'state-completed')
        ? Effect.sync(() => {
            completionFails = false;
          }).pipe(Effect.andThen(Effect.fail(new LinearRequestError())))
        : Effect.sync(() => {
            calls.push({ op: 'setState', issueId, stateId });
            const current = issues.get(issueId);
            const state = metadata.states.find((item) => item.id === stateId);
            if (current === undefined || state === undefined) {
              return;
            }
            issues.set(issueId, { ...current, state });
            readBackFails = options.failReadBack === true && state.type === 'started';
          }),
    setAssignee: (issueId, assigneeId) =>
      Effect.sync(() => {
        calls.push({ op: 'setAssignee', issueId, assigneeId });
        const current = issues.get(issueId);
        if (current === undefined) {
          return;
        }
        issues.set(issueId, {
          ...current,
          assigneeId: options.steal === true ? 'other-user' : assigneeId,
        });
      }),
    setLabels: (issueId, addedLabelIds, removedLabelIds) =>
      Effect.sync(() => {
        calls.push({ op: 'setLabels', issueId, addedLabelIds, removedLabelIds });
        const current = issues.get(issueId);
        if (current === undefined) {
          return;
        }
        const removed = new Set(removedLabelIds);
        const kept = current.labels.filter((label) => !removed.has(label.id));
        const present = new Set(kept.map((label) => label.id));
        const added = addedLabelIds.flatMap((id) => {
          const label = labelById.get(id);
          return label === undefined || present.has(id) ? [] : [label];
        });
        issues.set(issueId, { ...current, labels: [...kept, ...added] });
      }),
    createRelation: (input) =>
      Effect.sync(() => {
        calls.push({ op: 'createRelation', issueId: input.issueId, relatedIssueId: input.relatedIssueId });
      }),
    deleteRelation: (relationId) =>
      Effect.sync(() => {
        calls.push({ op: 'deleteRelation', relationId });
      }),
  });

  return { calls, issues, layer };
};

const withRepo = (api: ReturnType<typeof fakeLinear>, config: { readonly defaultKind?: string } = {}) =>
  TicketSourceLinearLive.pipe(
    Layer.provide(api.layer),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ teamId: 'team-1', ...config })))
  );

const getManyIn = (
  api: ReturnType<typeof fakeLinear>,
  query: TicketQuery,
  config: { readonly defaultKind?: string } = {}
) =>
  TicketSource.pipe(
    Effect.flatMap((source) => source.getManyBy(query)),
    Effect.provide(withRepo(api, config))
  );

// The report of done, and what the Source does after the merge, which the caller runs.
const reportDoneIn = (api: ReturnType<typeof fakeLinear>) =>
  TicketSource.pipe(
    Effect.flatMap((source) =>
      source.reportDone(toLinearId(uuid), { path: '/repo/.sandcastle/worktrees/ticket-linear', branch: 'ticket-linear' })
    ),
    Effect.provide(withRepo(api))
  );

const reportIn = (api: ReturnType<typeof fakeLinear>, event: TicketEvent) =>
  TicketSource.pipe(
    Effect.flatMap((source) => source.report(toLinearId(uuid), event)),
    Effect.provide(withRepo(api))
  );

const getUnreadableIn = (api: ReturnType<typeof fakeLinear>) =>
  TicketSource.pipe(
    Effect.flatMap((source) => source.getUnreadable),
    Effect.provide(withRepo(api))
  );

const getOneIn = (api: ReturnType<typeof fakeLinear>, query: TicketQuery) =>
  TicketSource.pipe(
    Effect.flatMap((source) => source.getOneBy(query)),
    Effect.provide(withRepo(api))
  );

test('report of claimed assigns the API-key user and the first started state, then confirms', async () => {
  const api = fakeLinear([issue({})]);

  await Effect.runPromise(reportIn(api, 'claimed'));

  expect(api.calls).toEqual([
    { op: 'setAssignee', issueId: uuid, assigneeId: 'viewer-1' },
    { op: 'setState', issueId: uuid, stateId: 'state-started' },
  ]);
  expect(api.issues.get(uuid)?.assigneeId).toBe('viewer-1');
  expect(api.issues.get(uuid)?.state.type).toBe('started');
});

test('report of claimed fails when the read back shows a lost Claim', async () => {
  const api = fakeLinear([issue({})], { steal: true });

  const error = await Effect.runPromise(reportIn(api, 'claimed').pipe(Effect.flip));

  expect(error).toEqual(new TicketEventNotReported({ ticketId: toLinearId(uuid), event: 'claimed' }));
});

test('report of claimed fails and writes nothing for an Issue already in a started state', async () => {
  // Another Engine, perhaps with the same API key, claimed the Issue since it was read.
  const api = fakeLinear([issue({ stateType: 'started', assigneeId: 'viewer-1' })]);

  const error = await Effect.runPromise(reportIn(api, 'claimed').pipe(Effect.flip));

  expect(error).toEqual(new TicketEventNotReported({ ticketId: toLinearId(uuid), event: 'claimed' }));
  expect(api.calls).toEqual([]);
});

test.each(['backlog', 'triage', 'canceled', 'completed'])(
  'report of claimed fails and writes nothing for an Issue that left its unstarted state for a %s state',
  async (stateType) => {
    const api = fakeLinear([issue({ stateType })]);

    const error = await Effect.runPromise(reportIn(api, 'claimed').pipe(Effect.flip));

    expect(error).toEqual(new TicketEventNotReported({ ticketId: toLinearId(uuid), event: 'claimed' }));
    expect(api.calls).toEqual([]);
  }
);

test('report of released moves a started Issue of the API-key user to the first unstarted state and unassigns it', async () => {
  const api = fakeLinear([issue({ stateType: 'started', assigneeId: 'viewer-1' })]);

  await Effect.runPromise(reportIn(api, 'released'));

  expect(api.calls).toEqual([
    { op: 'setState', issueId: uuid, stateId: 'state-unstarted' },
    { op: 'setAssignee', issueId: uuid, assigneeId: null },
  ]);
  expect(api.issues.get(uuid)?.assigneeId).toBeNull();
  expect(api.issues.get(uuid)?.state.type).toBe('unstarted');
});

test.each([
  ['assigned to another user', 'other-user'],
  ['assigned to no one', null],
])('report of released leaves a started Issue %s with its assignee and state', async (_, assigneeId) => {
  const api = fakeLinear([issue({ stateType: 'started', assigneeId })]);

  await Effect.runPromise(reportIn(api, 'released'));

  expect(api.calls).toEqual([]);
  expect(api.issues.get(uuid)?.assigneeId).toBe(assigneeId);
  expect(api.issues.get(uuid)?.state.type).toBe('started');
});

test('report of released that fails on its first write leaves the Issue as Rippls holds it, so it can run again', async () => {
  const api = fakeLinear([issue({ stateType: 'started', assigneeId: 'viewer-1' })], { failStates: true });

  const error = await Effect.runPromise(reportIn(api, 'released').pipe(Effect.flip));

  expect(error).toEqual(new TicketEventNotReported({ ticketId: toLinearId(uuid), event: 'released' }));
  expect(api.calls).toEqual([]);
  expect(api.issues.get(uuid)?.assigneeId).toBe('viewer-1');
  expect(api.issues.get(uuid)?.state.type).toBe('started');
});

test.each(['unstarted', 'backlog', 'triage', 'canceled', 'completed'])(
  'report of released writes nothing for an Issue in a %s state, which holds no Claim on Linear',
  async (stateType) => {
    const api = fakeLinear([issue({ stateType, assigneeId: 'someone' })]);

    await Effect.runPromise(reportIn(api, 'released'));

    expect(api.calls).toEqual([]);
  }
);

test('a started Issue is read in scope and by identity as claimed on Linear, and an unstarted one is not', async () => {
  const api = fakeLinear([
    issue({ id: 'started', createdAt: '2026-01-01T00:00:00.000Z', stateType: 'started', assigneeId: 'other-user' }),
    issue({ id: 'unstarted', createdAt: '2026-02-01T00:00:00.000Z' }),
  ]);

  const inScope = await Effect.runPromise(getManyIn(api, {}));
  const byIdentity = await Effect.runPromise(getOneIn(api, { id: toLinearId('started') }));

  expect(inScope.map((ticket) => [ticket.id, ticket.claimedInSource])).toEqual([
    [toLinearId('started'), true],
    [toLinearId('unstarted'), false],
  ]);
  expect([byIdentity.id, byIdentity.claimedInSource]).toEqual([toLinearId('started'), true]);
});

test('report of done writes nothing, and what it leaves for after the merge moves the Issue to the first completed state', async () => {
  const api = fakeLinear([issue({ stateType: 'started', assigneeId: 'viewer-1' })]);

  const afterMerge = await Effect.runPromise(reportDoneIn(api));

  expect(api.calls).toEqual([]);
  expect(api.issues.get(uuid)?.state.type).toBe('started');

  await Effect.runPromise(afterMerge);

  expect(api.calls).toEqual([{ op: 'setState', issueId: uuid, stateId: 'state-completed' }]);
  expect(api.issues.get(uuid)?.state.type).toBe('completed');
});

test('what report of done leaves for after the merge fails as a done report when the Linear write fails', async () => {
  const api = fakeLinear([issue({ stateType: 'started', assigneeId: 'viewer-1' })], { failStates: true });

  const error = await Effect.runPromise(reportDoneIn(api).pipe(Effect.flatMap((afterMerge) => afterMerge), Effect.flip));

  expect(error).toEqual(new TicketEventNotReported({ ticketId: toLinearId(uuid), event: 'done' }));
});

test('report of escalated unassigns, moves to the first unstarted state, and adds needs-human, leaving the kind and hitl labels', async () => {
  const api = fakeLinear([
    issue({
      stateType: 'started',
      assigneeId: 'viewer-1',
      labels: [
        { id: 'label-task', name: 'kind:task' },
        { id: 'label-hitl-no', name: 'hitl:no' },
        { id: 'label-priority', name: 'priority:high' },
      ],
    }),
  ]);

  await Effect.runPromise(reportIn(api, 'escalated'));

  expect(api.calls).toEqual([
    { op: 'setAssignee', issueId: uuid, assigneeId: null },
    { op: 'setState', issueId: uuid, stateId: 'state-unstarted' },
    { op: 'setLabels', issueId: uuid, addedLabelIds: ['label-needs-human'], removedLabelIds: [] },
  ]);
  expect(api.issues.get(uuid)?.labels.map((label) => label.name)).toEqual([
    'kind:task',
    'hitl:no',
    'priority:high',
    'needs-human',
  ]);
});

test('an Issue with the needs-human label is read as HITL yes, and keeps its kind', async () => {
  const api = fakeLinear([
    issue({
      labels: [
        { id: 'label-impl', name: 'kind:implementation' },
        { id: 'label-needs-human', name: 'needs-human' },
      ],
    }),
  ]);

  const [read] = await Effect.runPromise(getManyIn(api, {}));

  expect(read?.kind).toBe('implementation');
  expect(read?.hitl).toBe('yes');
});

test('an Issue with no labels is read with the default Ticket Kind and HITL yes', async () => {
  const api = fakeLinear([issue({ labels: [] })]);

  const [read] = await Effect.runPromise(getManyIn(api, {}));
  const [configured] = await Effect.runPromise(getManyIn(api, {}, { defaultKind: 'research' }));

  expect(read?.kind).toBe('implementation');
  expect(read?.hitl).toBe('yes');
  expect(configured?.kind).toBe('research');
  expect(configured?.hitl).toBe('yes');
});

test('a stated kind label implies the HITL of its Ticket Kind', async () => {
  const api = fakeLinear([
    issue({ id: uuid, labels: [{ id: 'label-impl', name: 'kind:implementation' }], createdAt: '2026-01-01T00:00:00.000Z' }),
    issue({ id: other, labels: [{ id: 'label-proto', name: 'kind:prototype' }], createdAt: '2026-01-02T00:00:00.000Z' }),
  ]);

  const tickets = await Effect.runPromise(getManyIn(api, {}));

  expect(tickets.map((ticket) => [ticket.kind, ticket.hitl])).toEqual([
    ['implementation', 'no'],
    ['prototype', 'yes'],
  ]);
});

test('report of escalated in a team without a needs-human label warns and succeeds', async () => {
  const warnings: string[] = [];
  const capturing: Console.Console = Object.assign(Object.create(console), {
    warn: (...args: ReadonlyArray<unknown>) => {
      warnings.push(args.map(String).join(' '));
    },
  });
  const api = fakeLinear([issue({ stateType: 'started', assigneeId: 'viewer-1' })], {
    labels: metadata.labels.filter((label) => label.name !== 'needs-human'),
  });

  await Effect.runPromise(reportIn(api, 'escalated').pipe(Effect.provide(Layer.succeed(Console.Console, capturing))));

  expect(api.calls).toEqual([
    { op: 'setAssignee', issueId: uuid, assigneeId: null },
    { op: 'setState', issueId: uuid, stateId: 'state-unstarted' },
  ]);
  expect(warnings).toEqual([
    `The Linear team has no needs-human label, so the escalation of ticket ${toLinearId(uuid)} shows only in the Ledger`,
  ]);
});

test('report of retried removes needs-human and leaves the other labels, the assignee, and the state', async () => {
  const api = fakeLinear([
    issue({
      labels: [
        { id: 'label-task', name: 'kind:task' },
        { id: 'label-hitl-no', name: 'hitl:no' },
        { id: 'label-needs-human', name: 'needs-human' },
      ],
    }),
  ]);

  await Effect.runPromise(reportIn(api, 'retried'));
  const [read] = await Effect.runPromise(getManyIn(api, {}));

  expect(api.calls).toEqual([
    { op: 'setLabels', issueId: uuid, addedLabelIds: [], removedLabelIds: ['label-needs-human'] },
  ]);
  expect(api.issues.get(uuid)?.labels.map((label) => label.name)).toEqual(['kind:task', 'hitl:no']);
  expect(read?.hitl).toBe('no');
});

test('report of retried on an Issue without needs-human changes nothing', async () => {
  const api = fakeLinear([issue({})]);

  await Effect.runPromise(reportIn(api, 'retried'));

  expect(api.calls).toEqual([]);
});

test('getManyBy reads every unstarted and started issue in scope by creation time, oldest first', async () => {
  const api = fakeLinear([
    issue({ id: 'newest', createdAt: '2026-03-01T00:00:00.000Z' }),
    issue({ id: 'claimed', createdAt: '2026-01-01T00:00:00.000Z', stateType: 'started', assigneeId: 'viewer-1' }),
    issue({ id: 'blocked', createdAt: '2026-02-01T00:00:00.000Z', inverse: [{ issueId: 'claimed' }] }),
    issue({
      id: 'attended',
      createdAt: '2026-02-15T00:00:00.000Z',
      labels: [
        { id: 'label-task', name: 'kind:task' },
        { id: 'label-hitl-yes', name: 'hitl:yes' },
      ],
    }),
    issue({ id: 'completed', createdAt: '2025-12-01T00:00:00.000Z', stateType: 'completed' }),
  ]);

  const tickets = await Effect.runPromise(getManyIn(api, {}));

  expect(tickets.map((ticket) => ticket.id)).toEqual(
    ['claimed', 'blocked', 'attended', 'newest'].map((native) => toLinearId(native))
  );
});

test('getManyBy narrows by Project and keeps the creation order', async () => {
  const other = { id: 'proj-2', name: 'Other Work', slugId: 'def456' };
  const api = fakeLinear([
    issue({ id: 'later', createdAt: '2026-03-01T00:00:00.000Z' }),
    issue({ id: 'other', createdAt: '2026-01-01T00:00:00.000Z', project: other }),
    issue({ id: 'none', createdAt: '2026-01-15T00:00:00.000Z', project: null }),
    issue({ id: 'earlier', createdAt: '2026-02-01T00:00:00.000Z' }),
  ]);

  const tickets = await Effect.runPromise(getManyIn(api, { project: toProject('chubby-engine') }));

  expect(tickets.map((ticket) => ticket.id)).toEqual([toLinearId('earlier'), toLinearId('later')]);
});

test('getUnreadable reports each offered Issue with an invalid hint, named by its identifier, oldest first', async () => {
  const api = fakeLinear([
    issue({ id: 'readable', createdAt: '2026-01-01T00:00:00.000Z' }),
    issue({ id: 'two-kinds', createdAt: '2026-03-01T00:00:00.000Z', labels: [
      { id: 'label-impl', name: 'kind:implementation' },
      { id: 'label-task', name: 'kind:task' },
    ] }),
    issue({ id: 'unknown-kind', createdAt: '2026-02-01T00:00:00.000Z', labels: [{ id: 'label-chore', name: 'kind:chore' }] }),
  ]);

  const unreadable = await Effect.runPromise(getUnreadableIn(api));

  expect(unreadable.map(({ name, id, reason }) => [name, id, reason])).toEqual([
    ['ENG-24', toLinearId('unknown-kind'), 'invalid hint'],
    ['ENG-24', toLinearId('two-kinds'), 'invalid hint'],
  ]);
  expect(unreadable.map(({ detail }) => detail)).toEqual([
    expect.stringContaining('["kind"]'),
    expect.stringContaining('["kind"]'),
  ]);
});

test('getUnreadable reports a started Issue with an invalid hint that is assigned to the API-key user', async () => {
  const api = fakeLinear([
    issue({ id: 'unstarted', createdAt: '2026-02-01T00:00:00.000Z', labels: [{ id: 'label-chore', name: 'kind:chore' }] }),
    issue({
      id: 'held',
      createdAt: '2026-01-01T00:00:00.000Z',
      stateType: 'started',
      assigneeId: 'viewer-1',
      labels: [{ id: 'label-chore', name: 'kind:chore' }],
    }),
  ]);

  const unreadable = await Effect.runPromise(getUnreadableIn(api));

  expect(unreadable.map(({ name, id, reason }) => [name, id, reason])).toEqual([
    ['ENG-24', toLinearId('held'), 'invalid hint'],
    ['ENG-24', toLinearId('unstarted'), 'invalid hint'],
  ]);
});

test.each([
  ['another user', 'other-user'],
  ['no one', null],
])('getUnreadable leaves out a started Issue with an invalid hint that is assigned to %s', async (_, assigneeId) => {
  const api = fakeLinear([
    issue({ stateType: 'started', assigneeId, labels: [{ id: 'label-chore', name: 'kind:chore' }] }),
  ]);

  const unreadable = await Effect.runPromise(getUnreadableIn(api));

  expect(unreadable).toEqual([]);
});

test('getUnreadable still reports the offered Issues when the API-key user cannot be read', async () => {
  const api = fakeLinear(
    [
      issue({ id: 'unstarted', labels: [{ id: 'label-chore', name: 'kind:chore' }] }),
      issue({
        id: 'held',
        stateType: 'started',
        assigneeId: 'viewer-1',
        labels: [{ id: 'label-chore', name: 'kind:chore' }],
      }),
    ],
    { failMetadata: true }
  );

  const unreadable = await Effect.runPromise(getUnreadableIn(api));

  expect(unreadable.map(({ id }) => id)).toEqual([toLinearId('unstarted')]);
});

test('a read by identity finds a completed Issue as done', async () => {
  const api = fakeLinear([issue({ id: 'completed', stateType: 'completed' })]);

  const byIdentity = await Effect.runPromise(getOneIn(api, { id: toLinearId('completed') }));

  expect([byIdentity.id, byIdentity.doneInSource]).toEqual([toLinearId('completed'), true]);
});

test.each(['backlog', 'triage', 'canceled'])(
  'an Issue in a %s state is not offered for processing, and its read by identity finds it as not done',
  async (stateType) => {
    const api = fakeLinear([issue({ id: 'elsewhere', stateType })]);

    const offered = await Effect.runPromise(getManyIn(api, {}));
    const byIdentity = await Effect.runPromise(getOneIn(api, { id: toLinearId('elsewhere') }));

    expect(offered).toEqual([]);
    expect([byIdentity.id, byIdentity.doneInSource]).toEqual([toLinearId('elsewhere'), false]);
  }
);

// The Ticket Status of each ticket in scope, with the outstanding blockers, as
// `rippls status` derives them from the Linear Source and an empty Ledger.
const statusesIn = (api: ReturnType<typeof fakeLinear>, ledger = makeLedgerMemory()) =>
  Effect.runPromise(
    ticketStatuses({}).pipe(
      Effect.map((lines) =>
        lines.flatMap((line) => (line.status === 'unreadable' ? [] : [[line.ticket.id, line.status, line.blockers] as const]))
      ),
      Effect.provide(Layer.merge(withRepo(api), ledger.layer))
    )
  );

const printedIn = async (api: ReturnType<typeof fakeLinear>) => {
  const messages: string[] = [];
  const capturing: Console.Console = Object.assign(Object.create(console), {
    log: (...args: ReadonlyArray<unknown>) => {
      messages.push(args.map(String).join(' '));
    },
  });
  await Effect.runPromise(
    showStatus({}).pipe(
      Effect.provide(Layer.merge(withRepo(api), makeLedgerMemory().layer)),
      Effect.provideService(Console.Console, capturing)
    )
  );
  return messages;
};

test('a ticket whose only blocker is a completed Issue outside the read of the tickets in scope is Eligible', async () => {
  const api = fakeLinear([
    issue({ id: 'dependent', inverse: [{ issueId: 'blocker' }] }),
    issue({ id: 'blocker', stateType: 'completed' }),
  ]);

  expect(await statusesIn(api)).toEqual([[toLinearId('dependent'), 'eligible', undefined]]);
});

test.each(['backlog', 'triage', 'canceled'])(
  'a blocker in a %s state keeps its dependent blocked and is shown as open, not unresolved',
  async (stateType) => {
    const api = fakeLinear([
      issue({ id: 'dependent', inverse: [{ issueId: 'blocker' }] }),
      issue({ id: 'blocker', stateType }),
    ]);

    expect(await statusesIn(api)).toEqual([
      [toLinearId('dependent'), 'blocked', { open: [toLinearId('blocker')], unresolved: [] }],
    ]);
    expect(await printedIn(api)).toEqual([
      `${toLinearId('dependent')}  Linear writes  blocked  (Blockers: open ${toLinearId('blocker')})`,
    ]);
  }
);

const engine = Schema.decodeSync(EngineId)('linear-engine-0000');
const stoppedEngine = Schema.decodeSync(EngineId)('stopped-engine-0000');

// A Ledger on this host whose given Claim on the Issue was made by a process that
// runs, or by one that no longer runs, so is stale.
const ledgerWithClaim = (runs: boolean) => {
  const ledger = makeLedgerMemory();
  ledger.claims.set(
    toLinearId(uuid),
    Claim.make({ ticket: toLinearId(uuid), engine: stoppedEngine, process: 2, host: 'memory' })
  );
  if (runs) {
    ledger.running.add(2);
  }
  return ledger;
};

test.each([
  ['no record in the Ledger', () => makeLedgerMemory()],
  ['a live Claim in the Ledger', () => ledgerWithClaim(true)],
])('a started Issue with %s is claimed, not Eligible, and the poll does not take it', async (_, ledgerOf) => {
  const api = fakeLinear([issue({ stateType: 'started', assigneeId: 'viewer-1' })]);

  expect(await statusesIn(api, ledgerOf())).toEqual([[toLinearId(uuid), 'claimed', undefined]]);
  const taken = await Effect.runPromise(
    pollTicket(engine).pipe(Effect.provide(Layer.merge(withRepo(api), ledgerOf().layer)))
  );
  expect(Option.isNone(taken)).toBe(true);
  expect(api.calls).toEqual([]);
});

test('a started Issue whose Claim on this host is stale is Eligible, and taking it reports released, then claimed', async () => {
  const api = fakeLinear([issue({ stateType: 'started', assigneeId: 'viewer-1' })]);
  const ledger = ledgerWithClaim(false);

  expect(await statusesIn(api, ledgerWithClaim(false))).toEqual([[toLinearId(uuid), 'eligible', undefined]]);
  const taken = await Effect.runPromise(pollTicket(engine).pipe(Effect.provide(Layer.merge(withRepo(api), ledger.layer))));

  expect(Option.map(taken, (ticket) => ticket.id)).toEqual(Option.some(toLinearId(uuid)));
  expect(api.calls).toEqual([
    { op: 'setState', issueId: uuid, stateId: 'state-unstarted' },
    { op: 'setAssignee', issueId: uuid, assigneeId: null },
    { op: 'setAssignee', issueId: uuid, assigneeId: 'viewer-1' },
    { op: 'setState', issueId: uuid, stateId: 'state-started' },
  ]);
  expect(ledger.claims.get(toLinearId(uuid))?.engine).toBe(engine);
});

test('a started Issue whose stale release fails keeps the new Claim, is not taken, and is not claimed on Linear', async () => {
  const api = fakeLinear([issue({ stateType: 'started', assigneeId: 'viewer-1' })], { failStates: true });
  const ledger = ledgerWithClaim(false);

  const taken = await Effect.runPromise(pollTicket(engine).pipe(Effect.provide(Layer.merge(withRepo(api), ledger.layer))));

  expect(Option.isNone(taken)).toBe(true);
  expect(api.issues.get(uuid)?.state.type).toBe('started');
  expect(ledger.claims.get(toLinearId(uuid))?.engine).toBe(engine);
});

// The services of an Engine on the Linear Source: its Runner processes every ticket
// with a Strategy that succeeds, and `ran` receives those tickets.
const linearEngineLayer = (
  api: ReturnType<typeof fakeLinear>,
  ledger: ReturnType<typeof makeLedgerMemory>,
  ran: TicketId[]
) =>
  Layer.mergeAll(
    withRepo(api),
    ledger.layer,
    Path.layer,
    FileSystem.layerNoop({ exists: () => Effect.succeed(true), access: () => Effect.void }),
    Layer.succeed(RepositoryRoot, '/repo'),
    Layer.succeed(WorktreeManager, {
      prepareProject: (project) => Effect.succeed({ path: `/repo/.sandcastle/worktrees/${project}`, branch: project }),
      prepareTicket: () => Effect.succeed({ path: '/repo/.sandcastle/worktrees/ticket', branch: 'ticket' }),
      runCommand: () => Effect.die('runCommand should not be called'),
      isClean: () => Effect.succeed(true),
      mergeAndClose: () => Effect.void,
    }),
    Layer.succeed(HarnessSelector, {
      select: Effect.succeed({
        name: 'default',
        model: 'default-model',
        run: () => Effect.succeed({ completionSignal: undefined }),
      }),
    }),
    Layer.succeed(StrategySelector, {
      select: (kind) =>
        Effect.succeed({
          name: kind,
          run: (ticket) =>
            Effect.sync(() => {
              ran.push(ticket.id);
              return Result.succeed(undefined);
            }),
        }),
    })
  );

// A Watch on the Linear Source that runs until the claimed report of a ticket has
// failed, and then exits. `ran` receives the tickets a Runner processes, and
// `beforeExit` runs while the Engine is still up.
const runEngineUntilClaimFails = (
  api: ReturnType<typeof fakeLinear>,
  ledger: ReturnType<typeof makeLedgerMemory>,
  ran: TicketId[],
  beforeExit: () => void
) => {
  const messages: string[] = [];
  const capturing: Console.Console = Object.assign(Object.create(console), {
    log: (...args: ReadonlyArray<unknown>) => {
      messages.push(args.map(String).join(' '));
    },
  });
  const layer = linearEngineLayer(api, ledger, ran);
  return Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* runEngine({ watch: true }).pipe(
        Effect.provide(layer),
        Effect.provideService(Console.Console, capturing),
        Effect.forkChild({ startImmediately: true })
      );
      while (!messages.some((message) => message.includes('could not be claimed on the Source'))) {
        yield* Effect.yieldNow;
      }
      beforeExit();
      yield* Fiber.interrupt(fiber);
    })
  );
};

test('runEngine leaves a started Issue of a Stale Claim to the person who has taken it, and does not process the ticket', async () => {
  const api = fakeLinear([issue({ stateType: 'started', assigneeId: 'person-1' })]);
  const ledger = ledgerWithClaim(false);
  const ran: TicketId[] = [];
  let heldBeforeExit: Claim | undefined;

  await runEngineUntilClaimFails(api, ledger, ran, () => {
    heldBeforeExit = ledger.claims.get(toLinearId(uuid));
  });

  expect(ran).toEqual([]);
  expect(api.calls).toEqual([]);
  expect(api.issues.get(uuid)?.assigneeId).toBe('person-1');
  expect(api.issues.get(uuid)?.state.type).toBe('started');
  expect(heldBeforeExit).toBeDefined();
  expect(heldBeforeExit?.engine).not.toBe(stoppedEngine);
  expect(ledger.claims.has(toLinearId(uuid))).toBe(false);
});

test('an Issue whose claimed report fails on its read back is unassigned and unstarted again when the Engine exits', async () => {
  const api = fakeLinear([issue({})], { failReadBack: true });
  const ledger = makeLedgerMemory();
  const ran: TicketId[] = [];
  let beforeExit: { readonly issue?: LinearIssue; readonly claimed: boolean } | undefined;

  await runEngineUntilClaimFails(api, ledger, ran, () => {
    beforeExit = { issue: api.issues.get(uuid), claimed: ledger.claims.has(toLinearId(uuid)) };
  });

  expect(ran).toEqual([]);
  expect([beforeExit?.issue?.state.type, beforeExit?.issue?.assigneeId, beforeExit?.claimed]).toEqual([
    'started',
    'viewer-1',
    true,
  ]);
  expect(api.issues.get(uuid)?.assigneeId).toBeNull();
  expect(api.issues.get(uuid)?.state.type).toBe('unstarted');
  expect(ledger.claims.has(toLinearId(uuid))).toBe(false);
});

test('an Issue of a done ticket whose completion failed after the merge ends in a completed state once the Engine has exited', async () => {
  const api = fakeLinear([issue({})], { failFirstCompletion: true });
  const ledger = makeLedgerMemory();
  const ran: TicketId[] = [];
  const errors: string[] = [];
  const capturing: Console.Console = Object.assign(Object.create(console), {
    error: (...args: ReadonlyArray<unknown>) => {
      errors.push(args.map(String).join(' '));
    },
  });

  await Effect.runPromise(
    runEngine({ limit: 1 }).pipe(
      Effect.provide(linearEngineLayer(api, ledger, ran)),
      Effect.provideService(Console.Console, capturing)
    )
  );

  expect(ran).toEqual([toLinearId(uuid)]);
  expect(errors.some((message) => message.includes('could not be completed on the Source after the merge'))).toBe(true);
  expect(api.issues.get(uuid)?.state.type).toBe('completed');
  expect(ledger.done.has(toLinearId(uuid))).toBe(true);
  expect(ledger.claims.has(toLinearId(uuid))).toBe(false);
});

test('a poll that meets a Stale Claim on a done ticket completes its started Issue, removes the record, and does not take it', async () => {
  const api = fakeLinear([issue({ stateType: 'started', assigneeId: 'viewer-1' })]);
  const ledger = ledgerWithClaim(false);
  ledger.done.add(toLinearId(uuid));

  const taken = await Effect.runPromise(pollTicket(engine).pipe(Effect.provide(Layer.merge(withRepo(api), ledger.layer))));

  expect(Option.isNone(taken)).toBe(true);
  expect(api.issues.get(uuid)?.state.type).toBe('completed');
  expect(ledger.claims.has(toLinearId(uuid))).toBe(false);
});

test('report of done leaves an Issue that Rippls does not hold as it is', async () => {
  const api = fakeLinear([issue({ stateType: 'started', assigneeId: 'person-1' })]);

  await Effect.runPromise(reportIn(api, 'done'));

  expect(api.calls).toEqual([]);
  expect(api.issues.get(uuid)?.state.type).toBe('started');
});

test.each(['backlog', 'triage', 'canceled'])('the poll never offers an Issue in a %s state', async (stateType) => {
  const api = fakeLinear([issue({ stateType })]);

  const taken = await Effect.runPromise(
    pollTicket(engine).pipe(Effect.provide(Layer.merge(withRepo(api), makeLedgerMemory().layer)))
  );

  expect(Option.isNone(taken)).toBe(true);
  expect(api.calls).toEqual([]);
});
