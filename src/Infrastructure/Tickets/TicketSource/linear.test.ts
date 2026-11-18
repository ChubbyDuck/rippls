import { ConfigProvider, Effect, Layer } from 'effect';
import { expect, test } from 'vitest';

import { Ticket } from '~/Core/Tickets/Domain/Entities/Ticket/entity';
import type { TicketEvent } from '~/Core/Tickets/Domain/Events/TicketEvent';
import { TicketEventNotReported } from '~/Core/Tickets/Domain/Exceptions/TicketEventNotReported';
import { TicketQuery } from '~/Core/Tickets/Domain/Queries/TicketQuery';
import {
  LinearApi,
  type LinearIssue,
  LinearIssueNotFound,
  type LinearLabel,
  type LinearMetadata,
} from '~/Core/Tickets/Ports/LinearApi';
import { TicketSource } from '~/Core/Tickets/Ports/TicketSource';
import { toLinearId } from '~/Infrastructure/Tickets/LinearApi/codec';

import { TicketSourceLinearLive } from './linear';

const uuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

const metadata: LinearMetadata = {
  viewer: { id: 'viewer-1', name: 'Dev' },
  states: [
    { id: 'state-unstarted', name: 'Todo', type: 'unstarted' },
    { id: 'state-started', name: 'In Progress', type: 'started' },
    { id: 'state-completed', name: 'Done', type: 'completed' },
  ],
  labels: [
    { id: 'label-impl', name: 'kind:implementation' },
    { id: 'label-task', name: 'kind:task' },
    { id: 'label-hitl-yes', name: 'hitl:yes' },
    { id: 'label-hitl-no', name: 'hitl:no' },
    { id: 'label-priority', name: 'priority:high' },
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
  state:
    fields.stateType === 'started'
      ? { id: 'state-started', name: 'In Progress', type: 'started' }
      : fields.stateType === 'completed'
        ? { id: 'state-completed', name: 'Done', type: 'completed' }
        : { id: 'state-unstarted', name: 'Todo', type: 'unstarted' },
  project: fields.project === undefined ? { id: 'proj-1', name: 'Chubby Engine', slugId: 'abc123' } : fields.project,
  labels: fields.labels ?? [{ id: 'label-impl', name: 'kind:implementation' }],
  relations: [],
  inverseRelations: (fields.inverse ?? []).map((relation, index) => ({
    relationId: `in-${index}`,
    issueId: relation.issueId,
    type: 'blocks' as const,
  })),
});

const readyTicket = Ticket.create({
  id: toLinearId(uuid),
  title: 'Linear writes',
  project: 'chubby-engine',
  kind: 'implementation',
  status: 'ready-for-agent',
  blockedBy: [],
  blocks: [],
  body: 'Claim and complete.',
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

const fakeLinear = (seed: readonly LinearIssue[], options: { readonly steal?: boolean } = {}) => {
  const issues = new Map(seed.map((item) => [item.id, item]));
  const calls: Mutation[] = [];
  const labelById = new Map(metadata.labels.map((label) => [label.id, label]));

  const layer = Layer.succeed(LinearApi, {
    metadata: () => Effect.succeed(metadata),
    issues: () => Effect.succeed([...issues.values()]),
    issue: (id) => {
      const found = issues.get(id);
      return found === undefined ? Effect.fail(new LinearIssueNotFound()) : Effect.succeed(found);
    },
    setState: (issueId, stateId) =>
      Effect.sync(() => {
        calls.push({ op: 'setState', issueId, stateId });
        const current = issues.get(issueId);
        const state = metadata.states.find((item) => item.id === stateId);
        if (current === undefined || state === undefined) {
          return;
        }
        issues.set(issueId, { ...current, state });
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

const withRepo = (api: ReturnType<typeof fakeLinear>) =>
  TicketSourceLinearLive.pipe(
    Layer.provide(api.layer),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ teamId: 'team-1' })))
  );

const getManyIn = (api: ReturnType<typeof fakeLinear>, query: TicketQuery) =>
  TicketSource.pipe(
    Effect.flatMap((source) => source.getManyBy(query)),
    Effect.provide(withRepo(api))
  );

const saveIn = (api: ReturnType<typeof fakeLinear>, ticket: Ticket) =>
  TicketSource.pipe(
    Effect.flatMap((source) => source.save(ticket)),
    Effect.provide(withRepo(api))
  );

const saveManyIn = (api: ReturnType<typeof fakeLinear>, tickets: readonly Ticket[]) =>
  TicketSource.pipe(
    Effect.flatMap((source) => source.saveMany(tickets)),
    Effect.provide(withRepo(api))
  );

const reportIn = (api: ReturnType<typeof fakeLinear>, event: TicketEvent) =>
  TicketSource.pipe(
    Effect.flatMap((source) => source.report(toLinearId(uuid), event)),
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

test('report of claimed writes nothing for an Issue that is already claimed by the API-key user', async () => {
  const api = fakeLinear([issue({ stateType: 'started', assigneeId: 'viewer-1' })]);

  await Effect.runPromise(reportIn(api, 'claimed'));

  expect(api.calls).toEqual([]);
});

test('report of released unassigns the Issue and moves it to the first unstarted state', async () => {
  const api = fakeLinear([issue({ stateType: 'started', assigneeId: 'viewer-1' })]);

  await Effect.runPromise(reportIn(api, 'released'));

  expect(api.calls).toEqual([
    { op: 'setAssignee', issueId: uuid, assigneeId: null },
    { op: 'setState', issueId: uuid, stateId: 'state-unstarted' },
  ]);
  expect(api.issues.get(uuid)?.assigneeId).toBeNull();
  expect(api.issues.get(uuid)?.state.type).toBe('unstarted');
});

test('a started Issue is not offered for processing, and its read by identity still finds it', async () => {
  const api = fakeLinear([
    issue({ id: 'started', createdAt: '2026-01-01T00:00:00.000Z', stateType: 'started', assigneeId: 'other-user' }),
    issue({ id: 'unstarted', createdAt: '2026-02-01T00:00:00.000Z' }),
  ]);

  const offered = await Effect.runPromise(getManyIn(api, TicketQuery.build()));
  const byIdentity = await Effect.runPromise(getOneIn(api, TicketQuery.byId(toLinearId('started')).build()));

  expect(offered.map((ticket) => ticket.id)).toEqual([toLinearId('unstarted')]);
  expect(byIdentity.id).toBe(toLinearId('started'));
});

test('save of a done ticket moves it to the completed state', async () => {
  const api = fakeLinear([issue({ stateType: 'started', assigneeId: 'viewer-1' })]);

  await Effect.runPromise(saveIn(api, readyTicket.done()));

  expect(api.calls).toEqual([{ op: 'setState', issueId: uuid, stateId: 'state-completed' }]);
});

test('save of an escalated ticket unassigns, unstarts, and edits grouped labels without dropping human labels', async () => {
  const api = fakeLinear([
    issue({
      stateType: 'started',
      assigneeId: 'viewer-1',
      labels: [
        { id: 'label-impl', name: 'kind:implementation' },
        { id: 'label-priority', name: 'priority:high' },
      ],
    }),
  ]);

  await Effect.runPromise(saveIn(api, readyTicket.escalate()));

  expect(api.calls).toEqual([
    { op: 'setAssignee', issueId: uuid, assigneeId: null },
    { op: 'setState', issueId: uuid, stateId: 'state-unstarted' },
    {
      op: 'setLabels',
      issueId: uuid,
      addedLabelIds: ['label-task', 'label-hitl-yes'],
      removedLabelIds: ['label-impl', 'label-hitl-no'],
    },
  ]);
  expect(api.issues.get(uuid)?.labels.map((label) => label.name)).toEqual([
    'priority:high',
    'kind:task',
    'hitl:yes',
  ]);
});

test('saveMany applies the writes of each ticket', async () => {
  const api = fakeLinear([issue({ stateType: 'started', assigneeId: 'viewer-1' })]);

  await Effect.runPromise(saveManyIn(api, [readyTicket.done()]));

  expect(api.calls).toEqual([{ op: 'setState', issueId: uuid, stateId: 'state-completed' }]);
});

test('getManyBy offers every unstarted issue in scope by creation time, oldest first', async () => {
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

  const tickets = await Effect.runPromise(getManyIn(api, TicketQuery.build()));

  expect(tickets.map((ticket) => ticket.id)).toEqual(
    ['blocked', 'attended', 'newest'].map((native) => toLinearId(native))
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

  const tickets = await Effect.runPromise(getManyIn(api, TicketQuery.byProject('chubby-engine' as never).build()));

  expect(tickets.map((ticket) => ticket.id)).toEqual([toLinearId('earlier'), toLinearId('later')]);
});
