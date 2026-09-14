import { Option, Schema } from 'effect';

import { type Ticket, TicketFromInput } from '~/Core/Tickets/Domain/Entities/Ticket/entity';
import { Hitl } from '~/Core/Tickets/Domain/Entities/Ticket/properties/Hitl';
import { formatTicketId, parseTicketId, type TicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';
import { TicketKind } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketKind';
import type { TicketStatus } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketStatus';
import type { LinearIssue, LinearLabel, LinearMetadata } from '~/Core/Tickets/Ports/LinearApi';

const statusByStateType = {
  triage: 'open',
  backlog: 'open',
  unstarted: 'ready-for-agent',
  started: 'claimed',
  completed: 'done',
  canceled: 'resolved',
  duplicate: 'resolved',
} as const satisfies Record<string, TicketStatus>;

export const slugify = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

export const stateTypeToStatus = (type: string): Option.Option<TicketStatus> => {
  if (!(type in statusByStateType)) {
    return Option.none();
  }
  return Option.some(statusByStateType[type as keyof typeof statusByStateType]);
};

const LINEAR_SOURCE = 'linear';

export const toLinearId = (native: string): TicketId => formatTicketId(LINEAR_SOURCE, native);

const groupedValue = (prefix: string, name: string): string | undefined => {
  const start = `${prefix}:`;
  return name.startsWith(start) ? name.slice(start.length) : undefined;
};

const singleGrouped = (labels: readonly LinearLabel[], prefix: string): Option.Option<string> => {
  const values = labels.flatMap((label) => {
    const value = groupedValue(prefix, label.name);
    return value === undefined ? [] : [value];
  });
  return values.length === 1 ? Option.some(values[0]) : Option.none();
};

export const labelsToKind = (labels: readonly LinearLabel[]): Option.Option<TicketKind> =>
  Option.flatMap(singleGrouped(labels, 'kind'), (value) => Schema.decodeUnknownOption(TicketKind)(value));

export const labelsToHitl = (labels: readonly LinearLabel[]): Option.Option<Hitl> =>
  Option.flatMap(singleGrouped(labels, 'hitl'), (value) => Schema.decodeUnknownOption(Hitl)(value));

const relatedIds = (relations: LinearIssue['relations'], type: 'blocks'): readonly TicketId[] =>
  relations.filter((relation) => relation.type === type).map((relation) => toLinearId(relation.issueId));

export const issueToTicket = (issue: LinearIssue, _metadata: LinearMetadata) => {
  const kind = labelsToKind(issue.labels);
  if (Option.isNone(kind)) {
    return Option.none();
  }

  const blockedBy = relatedIds(issue.inverseRelations, 'blocks');
  const status = blockedBy.length > 0 ? Option.some('blocked' as const) : stateTypeToStatus(issue.state.type);
  if (Option.isNone(status)) {
    return Option.none();
  }

  const project = issue.project === null ? '' : slugify(issue.project.name);
  const hitl = labelsToHitl(issue.labels);

  return Schema.decodeUnknownOption(TicketFromInput)({
    id: toLinearId(issue.id),
    title: issue.title,
    ...(project === '' ? {} : { project }),
    status: status.value,
    blockedBy,
    blocks: relatedIds(issue.relations, 'blocks'),
    kind: kind.value,
    ...(kind.value === 'task' ? { hitl: Option.getOrUndefined(hitl) } : {}),
    body: issue.description ?? '',
  });
};

export type LinearWrite =
  | { readonly op: 'setAssignee'; readonly issueId: string; readonly assigneeId: string | null }
  | { readonly op: 'setState'; readonly issueId: string; readonly stateId: string }
  | {
      readonly op: 'setLabels';
      readonly issueId: string;
      readonly addedLabelIds: readonly string[];
      readonly removedLabelIds: readonly string[];
    };

const firstStateId = (metadata: LinearMetadata, type: string): string | undefined =>
  metadata.states.find((state) => state.type === type)?.id;

const labelIdNamed = (metadata: LinearMetadata, name: string): string | undefined =>
  metadata.labels.find((label) => label.name === name)?.id;

const groupedKeep = new Set(['kind:task', 'hitl:yes']);

const escalateLabelWrites = (
  issueId: string,
  metadata: LinearMetadata
): readonly Extract<LinearWrite, { readonly op: 'setLabels' }>[] => {
  const addedLabelIds = [...groupedKeep].flatMap((name) => {
    const id = labelIdNamed(metadata, name);
    return id === undefined ? [] : [id];
  });
  const removedLabelIds = metadata.labels.flatMap((label) => {
    if ((!label.name.startsWith('kind:') && !label.name.startsWith('hitl:')) || groupedKeep.has(label.name)) {
      return [];
    }
    return [label.id];
  });
  return addedLabelIds.length === 0 && removedLabelIds.length === 0
    ? []
    : [{ op: 'setLabels', issueId, addedLabelIds, removedLabelIds }];
};

export const ticketToWrites = (ticket: Ticket, metadata: LinearMetadata): readonly LinearWrite[] => {
  const issueId = parseTicketId(ticket.id).native;
  const escalate = ticket.status === 'ready-for-agent' && ticket.kind === 'task' && ticket.hitl === 'yes';

  if (ticket.status === 'claimed' || ticket.status === 'claiming') {
    const stateId = firstStateId(metadata, 'started');
    return [
      { op: 'setAssignee', issueId, assigneeId: metadata.viewer.id },
      ...(stateId === undefined ? [] : [{ op: 'setState' as const, issueId, stateId }]),
    ];
  }

  if (ticket.status === 'done') {
    const stateId = firstStateId(metadata, 'completed');
    return stateId === undefined ? [] : [{ op: 'setState', issueId, stateId }];
  }

  if (ticket.status !== 'ready-for-agent') {
    return [];
  }

  const stateId = firstStateId(metadata, 'unstarted');
  const writes: LinearWrite[] = [
    { op: 'setAssignee', issueId, assigneeId: null },
    ...(stateId === undefined ? [] : [{ op: 'setState' as const, issueId, stateId }]),
  ];

  return escalate ? [...writes, ...escalateLabelWrites(issueId, metadata)] : writes;
};
