import { type Option, Result, Schema } from 'effect';

import { type Ticket, TicketHints, ticketFromHints } from '~/Core/Tickets/Domain/Entities/Ticket/entity';
import { fallbackHitl } from '~/Core/Tickets/Domain/Entities/Ticket/properties/Hitl';
import { formatTicketId, type TicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';
import type { TicketKind } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketKind';
import { detailOf, UnreadableTicket } from '~/Core/Tickets/Domain/Entities/UnreadableTicket/entity';
import type { LinearIssue, LinearLabel, LinearMetadata } from '~/Core/Tickets/Ports/LinearApi';

export const slugify = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const LINEAR_SOURCE = 'linear';

export const toLinearId = (native: string): TicketId => formatTicketId(LINEAR_SOURCE, native);

const groupedValue = (prefix: string, name: string): string | undefined => {
  const start = `${prefix}:`;
  return name.startsWith(start) ? name.slice(start.length) : undefined;
};

/**
 * The value that the grouped labels of one prefix state as a hint: nothing without
 * such a label, the value of a single one, and all values when there are several.
 * Several values are no valid hint, so the Issue reads as unreadable.
 */
export const groupedHint = (labels: readonly LinearLabel[], prefix: string): string | readonly string[] | undefined => {
  const values = labels.flatMap((label) => {
    const value = groupedValue(prefix, label.name);
    return value === undefined ? [] : [value];
  });
  return values.length <= 1 ? values[0] : values;
};

/** The label that the Linear Source adds to an escalated Issue. */
export const NEEDS_HUMAN_LABEL = 'needs-human';

const needsHuman = (labels: readonly LinearLabel[]): boolean => labels.some((label) => label.name === NEEDS_HUMAN_LABEL);

const relatedIds = (relations: LinearIssue['relations'], type: 'blocks'): readonly TicketId[] =>
  relations.filter((relation) => relation.type === type).map((relation) => toLinearId(relation.issueId));

/**
 * The Ticket an Issue reads as, or why it is unreadable: a `kind` or `hitl` label
 * with an invalid value, or more than one of either, is an invalid hint. An
 * unreadable Issue is named by its identifier, such as `ENG-12`. An Issue without a
 * `kind` label has the default Ticket Kind. An Issue that needs a human keeps its
 * Ticket Kind and states HITL yes. Linear has no Marker, and its workflow state
 * does not make an Issue Unattended, so an Issue that states no HITL and no Ticket
 * Kind that implies one is HITL yes.
 */
export const readIssue = (issue: LinearIssue, defaultKind: TicketKind): Result.Result<Ticket, UnreadableTicket> => {
  const project = issue.project === null ? '' : slugify(issue.project.name);
  const id = toLinearId(issue.id);
  return Schema.decodeUnknownResult(TicketHints)({
    id,
    title: issue.title,
    ...(project === '' ? {} : { project }),
    blockedBy: relatedIds(issue.inverseRelations, 'blocks'),
    kind: groupedHint(issue.labels, 'kind'),
    hitl: needsHuman(issue.labels) ? 'yes' : groupedHint(issue.labels, 'hitl'),
    body: issue.description ?? '',
    doneInSource: issue.state.type === 'completed',
  }).pipe(
    Result.mapError(
      (error) =>
        new UnreadableTicket({
          name: issue.identifier,
          id,
          reason: 'invalid hint',
          detail: detailOf(error.message),
        })
    ),
    Result.map((hints) => ticketFromHints(hints, { kind: defaultKind, hitl: fallbackHitl }))
  );
};

/** The Ticket an Issue reads as, or none when it is unreadable (see `readIssue`). */
export const issueToTicket = (issue: LinearIssue, defaultKind: TicketKind): Option.Option<Ticket> =>
  Result.getSuccess(readIssue(issue, defaultKind));

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
