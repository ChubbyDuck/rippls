import { Option } from 'effect';
import { expect, test } from 'vitest';

import type { LinearIssue, LinearLabel, LinearMetadata } from '~/Core/Tickets/Ports/LinearApi';

import {
  claimWrites,
  doneWrites,
  escalateWrites,
  issueToTicket,
  groupedHint,
  releaseWrites,
  slugify,
  toLinearId,
} from './codec';

test('slugify turns a Linear project name into a branch-safe string', () => {
  expect(slugify('Chubby Engine')).toBe('chubby-engine');
  expect(slugify('Foo/Bar Baz!')).toBe('foo-bar-baz');
  expect(slugify('  Already-Slug  ')).toBe('already-slug');
});

test('groupedHint states nothing without a label, the value of one, and every value of several', () => {
  expect(groupedHint([], 'kind')).toBeUndefined();
  expect(groupedHint([{ id: '1', name: 'priority:high' }], 'kind')).toBeUndefined();
  expect(groupedHint([{ id: '1', name: 'kind:implementation' }], 'kind')).toBe('implementation');
  expect(
    groupedHint(
      [
        { id: '1', name: 'kind:implementation' },
        { id: '2', name: 'kind:task' },
      ],
      'kind'
    )
  ).toEqual(['implementation', 'task']);
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
  projects: [{ id: 'proj-1', name: 'Chubby Engine', slugId: 'abc123' }],
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
      : { id: 'proj-1', name: fields.projectName ?? 'Chubby Engine', slugId: 'abc123' },
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

test('issueToTicket reads an issue with no labels with the default Ticket Kind and HITL yes', () => {
  const ticket = Option.getOrThrow(issueToTicket(issue({ labels: [] }), 'implementation'));

  expect(ticket.kind).toBe('implementation');
  expect(ticket.hitl).toBe('yes');
  expect(Option.getOrThrow(issueToTicket(issue({ labels: [] }), 'research')).kind).toBe('research');
});

test('issueToTicket does not read an issue with an invalid or a second kind or hitl label', () => {
  const read = (labels: readonly LinearLabel[]) => issueToTicket(issue({ labels }), 'implementation');

  expect(Option.isNone(read([{ id: '1', name: 'kind:chore' }, { id: '2', name: 'hitl:no' }]))).toBe(true);
  expect(
    Option.isNone(
      read([
        { id: '1', name: 'kind:implementation' },
        { id: '2', name: 'kind:task' },
      ])
    )
  ).toBe(true);
  expect(Option.isNone(read([{ id: '1', name: 'hitl:maybe' }]))).toBe(true);
  expect(
    Option.isNone(
      read([
        { id: '1', name: 'hitl:no' },
        { id: '2', name: 'hitl:yes' },
      ])
    )
  ).toBe(true);
});

test('issueToTicket takes the HITL that a stated kind label implies, and a hitl label over it', () => {
  const read = (labels: readonly LinearLabel[]) => Option.getOrThrow(issueToTicket(issue({ labels }), 'implementation'));

  expect(read([{ id: '1', name: 'kind:implementation' }]).hitl).toBe('no');
  expect(read([{ id: '1', name: 'kind:prototype' }]).hitl).toBe('yes');
  expect(read([{ id: '1', name: 'kind:task' }]).hitl).toBe('yes');
  expect(read([{ id: '1', name: 'kind:task' }, { id: '2', name: 'hitl:no' }]).hitl).toBe('no');
  expect(read([{ id: '2', name: 'hitl:no' }]).hitl).toBe('no');
});

test('issueToTicket does not read the workflow state as a marker', () => {
  expect(Option.getOrThrow(issueToTicket(issue({ labels: [], stateType: 'unstarted' }), 'implementation')).hitl).toBe(
    'yes'
  );
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
      'implementation'
    )
  );

  expect(ticket.id).toBe(`linear:${uuid}`);
  expect(ticket.title).toBe('Pure Linear codecs');
  expect(ticket.body).toBe('Convert an issue to a Ticket.');
  expect(ticket.project).toBe('chubby-engine');
  expect(ticket.kind).toBe('implementation');
  expect(ticket.hitl).toBe('no');
  expect(ticket.doneInSource).toBe(false);
  expect(ticket.blockedBy).toEqual([`linear:${blocker}`]);
});

test('issueToTicket reads a completed issue as done in its Source', () => {
  expect(Option.getOrThrow(issueToTicket(issue({ stateType: 'completed' }), 'implementation')).doneInSource).toBe(true);
});

test('claimWrites assign the Issue to the API-key user and move it to the first started state', () => {
  expect(claimWrites(uuid, metadata)).toEqual([
    { op: 'setAssignee', issueId: uuid, assigneeId: 'viewer-1' },
    { op: 'setState', issueId: uuid, stateId: 'state-started' },
  ]);
});

test('releaseWrites unassign the Issue and move it to the first unstarted state', () => {
  expect(releaseWrites(uuid, metadata)).toEqual([
    { op: 'setAssignee', issueId: uuid, assigneeId: null },
    { op: 'setState', issueId: uuid, stateId: 'state-unstarted' },
  ]);
});

test('doneWrites move the Issue to the first completed state', () => {
  expect(doneWrites(uuid, metadata)).toEqual([
    { op: 'setState', issueId: uuid, stateId: 'state-completed' },
  ]);
});

test('escalateWrites unassign, unstart, and add needs-human, leaving the kind and hitl labels', () => {
  const withLabel = { ...metadata, labels: [...metadata.labels, { id: 'label-needs-human', name: 'needs-human' }] };
  expect(escalateWrites(uuid, withLabel)).toEqual([
    { op: 'setAssignee', issueId: uuid, assigneeId: null },
    { op: 'setState', issueId: uuid, stateId: 'state-unstarted' },
    { op: 'setLabels', issueId: uuid, addedLabelIds: ['label-needs-human'], removedLabelIds: [] },
  ]);
  expect(escalateWrites(uuid, metadata)).toEqual([
    { op: 'setAssignee', issueId: uuid, assigneeId: null },
    { op: 'setState', issueId: uuid, stateId: 'state-unstarted' },
  ]);
});
