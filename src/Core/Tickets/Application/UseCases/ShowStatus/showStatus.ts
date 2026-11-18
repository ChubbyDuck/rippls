import { Console, Effect } from 'effect';

import { readTicketScope } from '~/Core/Tickets/Application/Services/ticketScope';
import type { Claim } from '~/Core/Tickets/Domain/Entities/Claim/entity';
import type { Escalation } from '~/Core/Tickets/Domain/Entities/Escalation/entity';
import type { Ticket } from '~/Core/Tickets/Domain/Entities/Ticket/entity';
import {
  type DerivedTicketStatus,
  deriveTicketStatus,
  derivedTicketStatuses,
} from '~/Core/Tickets/Domain/Services/ticketStatus';

import type { ShowStatusCommand } from './command';

/**
 * One ticket in scope with its Ticket Status, and the Claim of a claimed ticket or
 * the Escalation of an escalated one.
 */
export type TicketStatusLine = {
  readonly ticket: Ticket;
  readonly status: DerivedTicketStatus;
  readonly claim?: Claim;
  readonly escalation?: Escalation;
};

/** The Ticket Status of every ticket in scope, in the Source's processing order. */
export const ticketStatuses = ({ project }: ShowStatusCommand) =>
  readTicketScope(project).pipe(
    Effect.map(({ tickets, claims, escalations, facts }) =>
      tickets.map((ticket): TicketStatusLine => {
        const status = deriveTicketStatus(ticket, facts);
        const claim = status === 'claimed' ? claims.get(ticket.id) : undefined;
        const escalation = status === 'escalated' ? escalations.get(ticket.id) : undefined;
        return {
          ticket,
          status,
          ...(claim === undefined ? {} : { claim }),
          ...(escalation === undefined ? {} : { escalation }),
        };
      })
    )
  );

const statusWidth = Math.max(...derivedTicketStatuses.map((status) => status.length));

const describeClaim = ({ engine, runner, process, host }: Claim) =>
  `Claim: Engine ${engine}, ${runner === undefined ? 'no Runner yet' : `Runner ${runner}`}, process ${process}, host ${host}`;

const describeEscalation = ({ reason, attempts, worktree }: Escalation) =>
  `Escalation: ${reason}, ${attempts} ${attempts === 1 ? 'attempt' : 'attempts'}, Ticket Worktree ${worktree}`;

/** The printed line of one ticket: its identity, its Ticket Status, its Title, and the owner or the escalation. */
export const formatStatusLine = ({ ticket, status, claim, escalation }: TicketStatusLine): string => {
  const detail =
    claim !== undefined ? describeClaim(claim) : escalation !== undefined ? describeEscalation(escalation) : undefined;
  const line = `${ticket.id}  ${status.padEnd(statusWidth)}  ${ticket.title}`;
  return detail === undefined ? line : `${line} (${detail})`;
};

/** Prints one line for every ticket in scope, with its Ticket Status. */
export const showStatus = Effect.fn('status.show')(function* (command: ShowStatusCommand) {
  const lines = yield* ticketStatuses(command);
  if (lines.length === 0) {
    return yield* Console.log('No tickets are in scope');
  }
  yield* Effect.forEach(lines, (line) => Console.log(formatStatusLine(line)), { discard: true });
});
