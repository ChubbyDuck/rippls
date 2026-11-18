import { Option, Schema } from 'effect';

import { Ticket, TicketFromInput } from '~/Core/Tickets/Domain/Entities/Ticket/entity';
import { Hitl } from '~/Core/Tickets/Domain/Entities/Ticket/properties/Hitl';
import { formatTicketId, type TicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';
import { TicketKind } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketKind';
import type { TicketStatus } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketStatus';
import type { LinearIssue, LinearLabel, LinearMetadata } from '~/Core/Tickets/Ports/LinearApi';

const statusByStateType = {
  triage: 'open',
  backlog: 'open',
  unstarted: 'ready-for-agent',
  // A started Issue is claimed on Linear. The Ticket holds no Claim, so it reads
  // as ready, and the Linear Source does not offer it for processing.
  started: 'ready-for-agent',
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

/** The label that the Linear Source adds to an escalated Issue. */
export const NEEDS_HUMAN_LABEL = 'needs-human';

const needsHuman = (labels: readonly LinearLabel[]): boolean => labels.some((label) => label.name === NEEDS_HUMAN_LABEL);

// An Issue that needs a human keeps its Ticket Kind and reads as HITL yes.
const attended = (ticket: Ticket): Ticket =>
  new Ticket({
    id: ticket.id,
    title: ticket.title,
    project: ticket.project,
    status: ticket.status,
    blockedBy: ticket.blockedBy,
    blocks: ticket.blocks,
    kind: ticket.kind,
    hitl: 'yes',
    body: ticket.body,
  });
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

  const ticket = Schema.decodeUnknownOption(TicketFromInput)({
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
  return needsHuman(issue.labels) ? Option.map(ticket, attended) : ticket;
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

/** The team's `needs-human` label, when the team has one. */
export const needsHumanLabelId = (metadata: LinearMetadata): string | undefined =>
  labelIdNamed(metadata, NEEDS_HUMAN_LABEL);
/** A Claim on Linear: assign the Issue to the API-key user and move it to the first `started` state. */
export const claimWrites = (issueId: string, metadata: LinearMetadata): readonly LinearWrite[] => {
  const stateId = firstStateId(metadata, 'started');
  return [
    { op: 'setAssignee', issueId, assigneeId: metadata.viewer.id },
    ...(stateId === undefined ? [] : [{ op: 'setState' as const, issueId, stateId }]),
  ];
};

/** A release on Linear: unassign the Issue and move it to the first `unstarted` state. */
export const releaseWrites = (issueId: string, metadata: LinearMetadata): readonly LinearWrite[] => {
  const stateId = firstStateId(metadata, 'unstarted');
  return [
    { op: 'setAssignee', issueId, assigneeId: null },
    ...(stateId === undefined ? [] : [{ op: 'setState' as const, issueId, stateId }]),
  ];
};

/**
 * An escalation on Linear: unassign the Issue, move it to the first `unstarted`
 * state, and add the `needs-human` label when the team has one. The `kind` and
 * `hitl` labels stay as they are.
 */
export const escalateWrites = (issueId: string, metadata: LinearMetadata): readonly LinearWrite[] => {
  const labelId = needsHumanLabelId(metadata);
  return [
    ...releaseWrites(issueId, metadata),
    ...(labelId === undefined
      ? []
      : [{ op: 'setLabels' as const, issueId, addedLabelIds: [labelId], removedLabelIds: [] }]),
  ];
};

/** A retry on Linear: remove the `needs-human` label when the team has one. */
export const retryWrites = (issueId: string, metadata: LinearMetadata): readonly LinearWrite[] => {
  const labelId = needsHumanLabelId(metadata);
  return labelId === undefined ? [] : [{ op: 'setLabels', issueId, addedLabelIds: [], removedLabelIds: [labelId] }];
};

/** Done on Linear: move the Issue to the first `completed` state. */
export const doneWrites = (issueId: string, metadata: LinearMetadata): readonly LinearWrite[] => {
  const stateId = firstStateId(metadata, 'completed');
  return stateId === undefined ? [] : [{ op: 'setState', issueId, stateId }];
};
