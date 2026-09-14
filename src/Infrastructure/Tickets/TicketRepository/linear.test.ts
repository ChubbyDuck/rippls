import { ConfigProvider, Effect, Layer, Schema } from 'effect';
import { expect, test } from 'vitest';

import { RunnerId } from '~/Core/Shared/Domain/Properties/RunnerId';
import { Ticket } from '~/Core/Tickets/Domain/Entities/Ticket/entity';
import { TicketNotSaved } from '~/Core/Tickets/Domain/Exceptions/TicketNotSaved';
import {
  LinearApi,
  type LinearIssue,
  LinearIssueNotFound,
  type LinearLabel,
  type LinearMetadata,
} from '~/Core/Tickets/Ports/LinearApi';
import { TicketRepository } from '~/Core/Tickets/Ports/TicketRepository';
import { toLinearId } from '~/Infrastructure/Tickets/LinearApi/codec';

import { TicketRepositoryLinearLive } from './linear';

const uuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const blockedUuid = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
const runner = Schema.decodeSync(RunnerId)('runner-1');

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
  projects: [{ id: 'proj-1', name: 'Chubby Harness', slugId: 'abc123' }],
};

const issue = (fields: {
  readonly id?: string;
  readonly labels?: readonly LinearLabel[];
  readonly stateType?: string;
  readonly assigneeId?: string | null;
  readonly inverse?: readonly { readonly issueId: string }[];
}): LinearIssue => ({
  id: fields.id ?? uuid,
  identifier: 'ENG-24',
  title: 'Linear writes',
  description: 'Claim and complete.',
  createdAt: '2026-01-01T00:00:00.000Z',
  assigneeId: fields.assigneeId === undefined ? null : fields.assigneeId,
  state:
    fields.stateType === 'started'
      ? { id: 'state-started', name: 'In Progress', type: 'started' }
      : fields.stateType === 'completed'
        ? { id: 'state-completed', name: 'Done', type: 'completed' }
        : { id: 'state-unstarted', name: 'Todo', type: 'unstarted' },
  project: { id: 'proj-1', name: 'Chubby Harness', slugId: 'abc123' },
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
  project: 'chubby-harness',
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
  TicketRepositoryLinearLive.pipe(
    Layer.provide(api.layer),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ teamId: 'team-1' })))
  );

const saveIn = (api: ReturnType<typeof fakeLinear>, ticket: Ticket) =>
  TicketRepository.pipe(
    Effect.flatMap((repo) => repo.save(ticket)),
    Effect.provide(withRepo(api))
  );

const saveManyIn = (api: ReturnType<typeof fakeLinear>, tickets: readonly Ticket[]) =>
  TicketRepository.pipe(
    Effect.flatMap((repo) => repo.saveMany(tickets)),
    Effect.provide(withRepo(api))
  );

test('save of a claiming ticket sets assignee and the first started state, then confirms', async () => {
  const api = fakeLinear([issue({})]);

  await Effect.runPromise(saveIn(api, readyTicket.markClaiming()));

  expect(api.calls).toEqual([
    { op: 'setAssignee', issueId: uuid, assigneeId: 'viewer-1' },
    { op: 'setState', issueId: uuid, stateId: 'state-started' },
  ]);
  expect(api.issues.get(uuid)?.assigneeId).toBe('viewer-1');
  expect(api.issues.get(uuid)?.state.type).toBe('started');
});

test('save of a claiming ticket fails when the re-read shows a lost race', async () => {
  const api = fakeLinear([issue({})], { steal: true });

  const error = await Effect.runPromise(saveIn(api, readyTicket.markClaiming()).pipe(Effect.flip));

  expect(error).toEqual(new TicketNotSaved());
});

test('save of a claimed ticket is idempotent', async () => {
  const api = fakeLinear([issue({})]);
  const claimed = readyTicket.claim({ by: runner });

  await Effect.runPromise(saveIn(api, claimed));
  await Effect.runPromise(saveIn(api, claimed));

  expect(api.calls).toEqual([
    { op: 'setAssignee', issueId: uuid, assigneeId: 'viewer-1' },
    { op: 'setState', issueId: uuid, stateId: 'state-started' },
  ]);
});

test('save of a done ticket moves it to the completed state', async () => {
  const api = fakeLinear([issue({ stateType: 'started', assigneeId: 'viewer-1' })]);

  await Effect.runPromise(saveIn(api, readyTicket.claim({ by: runner }).done()));

  expect(api.calls).toEqual([{ op: 'setState', issueId: uuid, stateId: 'state-completed' }]);
});

test('save of a released ticket unassigns and moves it to unstarted', async () => {
  const api = fakeLinear([issue({ stateType: 'started', assigneeId: 'viewer-1' })]);

  await Effect.runPromise(saveIn(api, readyTicket.claim({ by: runner }).release()));

  expect(api.calls).toEqual([
    { op: 'setAssignee', issueId: uuid, assigneeId: null },
    { op: 'setState', issueId: uuid, stateId: 'state-unstarted' },
  ]);
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

  await Effect.runPromise(saveIn(api, readyTicket.claim({ by: runner }).escalate()));

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

test('saveMany applies writes and unblock performs no write', async () => {
  const api = fakeLinear([
    issue({ stateType: 'started', assigneeId: 'viewer-1' }),
    issue({
      id: blockedUuid,
      inverse: [{ issueId: uuid }],
    }),
  ]);
  const blocked = Ticket.create({
    id: toLinearId(blockedUuid),
    title: 'Linear writes',
    project: 'chubby-harness',
    kind: 'implementation',
    status: 'blocked',
    blockedBy: [toLinearId(uuid)],
    blocks: [],
    body: 'Claim and complete.',
  });

  await Effect.runPromise(saveManyIn(api, [readyTicket.claim({ by: runner }).done(), blocked.unblockedBy(toLinearId(uuid))]));

  expect(api.calls).toEqual([{ op: 'setState', issueId: uuid, stateId: 'state-completed' }]);
});
