import { Option, Schema } from 'effect';
import { expect, test } from 'vitest';

import { RunnerId } from '~/Core/Shared/Domain/Properties/RunnerId';
import { Ticket } from '~/Core/Tickets/Domain/Entities/Ticket/entity';
import type { LinearIssue, LinearLabel, LinearMetadata } from '~/Core/Tickets/Ports/LinearApi';

import {
  issueToTicket,
  labelsToHitl,
  labelsToKind,
  slugify,
  stateTypeToStatus,
  ticketToWrites,
  toLinearId,
} from './codec';

test('slugify turns a Linear project name into a branch-safe string', () => {
  expect(slugify('Chubby Harness')).toBe('chubby-harness');
  expect(slugify('Foo/Bar Baz!')).toBe('foo-bar-baz');
  expect(slugify('  Already-Slug  ')).toBe('already-slug');
});

test('stateTypeToStatus covers every WorkflowState.type', () => {
  expect(Option.getOrThrow(stateTypeToStatus('triage'))).toBe('open');
  expect(Option.getOrThrow(stateTypeToStatus('backlog'))).toBe('open');
  expect(Option.getOrThrow(stateTypeToStatus('unstarted'))).toBe('ready-for-agent');
  expect(Option.getOrThrow(stateTypeToStatus('started'))).toBe('claimed');
  expect(Option.getOrThrow(stateTypeToStatus('completed'))).toBe('done');
  expect(Option.getOrThrow(stateTypeToStatus('canceled'))).toBe('resolved');
  expect(Option.getOrThrow(stateTypeToStatus('duplicate'))).toBe('resolved');
  expect(Option.isNone(stateTypeToStatus('unknown'))).toBe(true);
});

test('labelsToKind reads exactly one kind label', () => {
  expect(Option.getOrThrow(labelsToKind([{ id: '1', name: 'kind:implementation' }]))).toBe('implementation');
  expect(Option.isNone(labelsToKind([]))).toBe(true);
  expect(
    Option.isNone(
      labelsToKind([
        { id: '1', name: 'kind:implementation' },
        { id: '2', name: 'kind:task' },
      ])
    )
  ).toBe(true);
  expect(Option.isNone(labelsToKind([{ id: '1', name: 'kind:unknown' }]))).toBe(true);
});

test('labelsToHitl reads exactly one hitl label', () => {
  expect(Option.getOrThrow(labelsToHitl([{ id: '1', name: 'hitl:yes' }]))).toBe('yes');
  expect(Option.getOrThrow(labelsToHitl([{ id: '1', name: 'hitl:no' }]))).toBe('no');
  expect(Option.isNone(labelsToHitl([]))).toBe(true);
});

test('toLinearId namespaces a Linear UUID', () => {
  expect(toLinearId('a1b2c3d4-e5f6-7890-abcd-ef1234567890')).toBe(
    'linear:a1b2c3d4-e5f6-7890-abcd-ef1234567890'
  );
});

const uuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const blocker = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
const blocked = 'c3d4e5f6-a7b8-9012-cdef-123456789012';

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
  ],
  projects: [{ id: 'proj-1', name: 'Chubby Harness', slugId: 'abc123' }],
};

const issue = (fields: {
  readonly labels?: readonly LinearLabel[];
  readonly stateType?: string;
  readonly description?: string | null;
  readonly projectName?: string | null;
  readonly inverse?: readonly { readonly issueId: string; readonly type: 'blocks' | 'duplicate' | 'related' }[];
  readonly outgoing?: readonly { readonly issueId: string; readonly type: 'blocks' | 'duplicate' | 'related' }[];
}): LinearIssue => ({
  id: uuid,
  identifier: 'ENG-22',
  title: 'Pure Linear codecs',
  description: fields.description === undefined ? 'Convert an issue to a Ticket.' : fields.description,
  createdAt: '2026-01-01T00:00:00.000Z',
  assigneeId: null,
  state: { id: 'state-unstarted', name: 'Todo', type: fields.stateType ?? 'unstarted' },
  project:
    fields.projectName === null
      ? null
      : { id: 'proj-1', name: fields.projectName ?? 'Chubby Harness', slugId: 'abc123' },
  labels: fields.labels ?? [{ id: 'label-impl', name: 'kind:implementation' }],
  relations: (fields.outgoing ?? []).map((relation, index) => ({
    relationId: `out-${index}`,
    issueId: relation.issueId,
    type: relation.type,
  })),
  inverseRelations: (fields.inverse ?? []).map((relation, index) => ({
    relationId: `in-${index}`,
    issueId: relation.issueId,
    type: relation.type,
  })),
});

test('issueToTicket skips an issue that does not have a single kind label', () => {
  expect(Option.isNone(issueToTicket(issue({ labels: [] }), metadata))).toBe(true);
  expect(
    Option.isNone(
      issueToTicket(
        issue({
          labels: [
            { id: '1', name: 'kind:implementation' },
            { id: '2', name: 'kind:task' },
          ],
        }),
        metadata
      )
    )
  ).toBe(true);
});

test('issueToTicket maps native fields and incomplete blockers', () => {
  const ticket = Option.getOrThrow(
    issueToTicket(
      issue({
        inverse: [
          { issueId: blocker, type: 'blocks' },
          { issueId: blocked, type: 'related' },
        ],
        outgoing: [{ issueId: blocked, type: 'blocks' }],
      }),
      metadata
    )
  );

  expect(ticket.id).toBe(`linear:${uuid}`);
  expect(ticket.title).toBe('Pure Linear codecs');
  expect(ticket.body).toBe('Convert an issue to a Ticket.');
  expect(ticket.project).toBe('chubby-harness');
  expect(ticket.kind).toBe('implementation');
  expect(ticket.hitl).toBe('no');
  expect(ticket.status).toBe('blocked');
  expect(ticket.blockedBy).toEqual([`linear:${blocker}`]);
  expect(ticket.blocks).toEqual([`linear:${blocked}`]);
  expect(ticket.claimedBy).toBeUndefined();
});

const runner = Schema.decodeSync(RunnerId)('runner-1');

const readyTicket = Ticket.create({
  id: toLinearId(uuid),
  title: 'Pure Linear codecs',
  project: 'chubby-harness',
  kind: 'implementation',
  status: 'ready-for-agent',
  blockedBy: [],
  blocks: [],
  body: 'Convert an issue to a Ticket.',
});

test('ticketToWrites covers claim, done, release, and escalate', () => {
  const claimWrites = [
    { op: 'setAssignee', issueId: uuid, assigneeId: 'viewer-1' },
    { op: 'setState', issueId: uuid, stateId: 'state-started' },
  ];
  expect(ticketToWrites(readyTicket.markClaiming(), metadata)).toEqual(claimWrites);
  expect(ticketToWrites(readyTicket.claim({ by: runner }), metadata)).toEqual(claimWrites);
  expect(ticketToWrites(readyTicket.claim({ by: runner }).done(), metadata)).toEqual([
    { op: 'setState', issueId: uuid, stateId: 'state-completed' },
  ]);
  expect(ticketToWrites(readyTicket.claim({ by: runner }).release(), metadata)).toEqual([
    { op: 'setAssignee', issueId: uuid, assigneeId: null },
    { op: 'setState', issueId: uuid, stateId: 'state-unstarted' },
  ]);
  expect(ticketToWrites(readyTicket.claim({ by: runner }).escalate(), metadata)).toEqual([
    { op: 'setAssignee', issueId: uuid, assigneeId: null },
    { op: 'setState', issueId: uuid, stateId: 'state-unstarted' },
    {
      op: 'setLabels',
      issueId: uuid,
      addedLabelIds: ['label-task', 'label-hitl-yes'],
      removedLabelIds: ['label-impl'],
    },
  ]);
});
