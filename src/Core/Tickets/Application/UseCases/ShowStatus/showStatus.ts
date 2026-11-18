import { Console, Effect } from 'effect';

import { type OutstandingBlockers, outstandingBlockers } from '~/Core/Tickets/Application/Services/outstandingBlockers';
import { readTicketScope } from '~/Core/Tickets/Application/Services/ticketScope';
import type { Claim } from '~/Core/Tickets/Domain/Entities/Claim/entity';
import type { Escalation } from '~/Core/Tickets/Domain/Entities/Escalation/entity';
import type { Ticket } from '~/Core/Tickets/Domain/Entities/Ticket/entity';
import type { UnreadableTicket } from '~/Core/Tickets/Domain/Entities/UnreadableTicket/entity';
import { type TicketStatus, deriveTicketStatus } from '~/Core/Tickets/Domain/Services/ticketStatus';
import { TicketSource } from '~/Core/Tickets/Ports/TicketSource';

import type { ShowStatusCommand } from './command';

/**
 * One ticket in scope with its Ticket Status, and the Claim of a claimed ticket,
 * the Escalation of an escalated one, the outstanding blockers of a blocked one,
 * and the unresolved blockers of any other.
 */
export type TicketStatusLine = {
  readonly ticket: Ticket;
  readonly status: Exclude<TicketStatus, 'unreadable'>;
  readonly claim?: Claim;
  readonly escalation?: Escalation;
  readonly blockers?: OutstandingBlockers;
};

/** A ticket that its Source cannot read, with the reason. */
export type UnreadableStatusLine = {
  readonly status: 'unreadable';
  readonly unreadable: UnreadableTicket;
};

export type StatusLine = TicketStatusLine | UnreadableStatusLine;

// A blocked ticket shows its open and its unresolved blockers; any other ticket
// shows only the unresolved ones, so that none goes unreported.
const blockersShown = (
  status: TicketStatusLine['status'],
  blockers: OutstandingBlockers | undefined
): OutstandingBlockers | undefined => {
  if (blockers === undefined || status === 'blocked') {
    return blockers;
  }
  return blockers.unresolved.length === 0 ? undefined : { open: [], unresolved: blockers.unresolved };
};

/**
 * The Ticket Status of every ticket in scope, in the Source's processing order,
 * then every ticket the Source cannot read.
 */
export const ticketStatuses = ({ project }: ShowStatusCommand) =>
  Effect.gen(function* () {
    const source = yield* TicketSource;
    const scope = yield* readTicketScope(project);
    const { tickets, claims, escalations, facts } = scope;
    const outstanding = outstandingBlockers(scope);
    const unreadable = yield* source.getUnreadable;
    const read = tickets.map((ticket): TicketStatusLine => {
      const status = deriveTicketStatus(ticket, facts);
      const claim = status === 'claimed' ? claims.get(ticket.id) : undefined;
      const escalation = status === 'escalated' ? escalations.get(ticket.id) : undefined;
      const blockers = blockersShown(status, outstanding.get(ticket.id));
      return {
        ticket,
        status,
        ...(claim === undefined ? {} : { claim }),
        ...(escalation === undefined ? {} : { escalation }),
        ...(blockers === undefined ? {} : { blockers }),
      };
    });
    const lines: readonly StatusLine[] = [
      ...read,
      ...unreadable.map((ticket): UnreadableStatusLine => ({ status: 'unreadable', unreadable: ticket })),
    ];
    return lines;
  });

const describeClaim = ({ engine, runner, process, host }: Claim) =>
  `Claim: Engine ${engine}, ${runner === undefined ? 'no Runner yet' : `Runner ${runner}`}, process ${process}, host ${host}`;

const describeEscalation = ({ reason, attempts, worktree }: Escalation) =>
  `Escalation: ${reason}, ${attempts} ${attempts === 1 ? 'attempt' : 'attempts'}, Ticket Worktree ${worktree}`;

const describeBlockers = ({ open, unresolved }: OutstandingBlockers) =>
  [
    ...(open.length === 0 ? [] : [`open ${open.join(', ')}`]),
    ...(unresolved.length === 0 ? [] : [`unresolved ${unresolved.join(', ')}`]),
  ].join('; ');

// The details of a line, each printed in parentheses.
const describe = (line: StatusLine): readonly string[] => {
  if (line.status === 'unreadable') {
    return [line.unreadable.explanation];
  }
  const { claim, escalation, blockers } = line;
  return [
    ...(claim === undefined ? [] : [describeClaim(claim)]),
    ...(escalation === undefined ? [] : [describeEscalation(escalation)]),
    ...(blockers === undefined ? [] : [`Blockers: ${describeBlockers(blockers)}`]),
  ];
};

// The identity and the name of a line: the identity and Title of a ticket, or the
// identity, when the Source can tell one, and the name of an unreadable ticket.
const identityOf = (line: StatusLine): string =>
  line.status === 'unreadable' ? (line.unreadable.id ?? '-') : line.ticket.id;

const nameOf = (line: StatusLine): string => (line.status === 'unreadable' ? line.unreadable.name : line.ticket.title);

const widest = (values: readonly string[]) => Math.max(0, ...values.map((value) => value.length));

// The printed lines: the identity, the Title, and the Ticket Status of each
// ticket, in aligned columns, then the owner of a Claim, the Escalation, the
// outstanding blockers, or the reason a ticket is unreadable.
const formatStatusLines = (lines: readonly StatusLine[]): readonly string[] => {
  const idWidth = widest(lines.map(identityOf));
  const titleWidth = widest(lines.map(nameOf));
  return lines.map((line) => {
    const columns = [identityOf(line).padEnd(idWidth), nameOf(line).padEnd(titleWidth), line.status];
    return [...columns, ...describe(line).map((detail) => `(${detail})`)].join('  ').trimEnd();
  });
};

/** Prints one line for every ticket in scope, with its Ticket Status, then one for every unreadable ticket. */
export const showStatus = Effect.fn('status.show')(function* (command: ShowStatusCommand) {
  const lines = yield* ticketStatuses(command);
  if (lines.length === 0) {
    return yield* Console.log('No tickets are in scope');
  }
  yield* Effect.forEach(formatStatusLines(lines), (line) => Console.log(line), { discard: true });
});
