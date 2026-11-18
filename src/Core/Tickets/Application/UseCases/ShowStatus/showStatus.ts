import { Console, Effect } from 'effect';

import { readTicketScope } from '~/Core/Tickets/Application/Services/ticketScope';
import type { Claim } from '~/Core/Tickets/Domain/Entities/Claim/entity';
import type { Escalation } from '~/Core/Tickets/Domain/Entities/Escalation/entity';
import type { Ticket } from '~/Core/Tickets/Domain/Entities/Ticket/entity';
import { type DerivedTicketStatus, deriveTicketStatus } from '~/Core/Tickets/Domain/Services/ticketStatus';

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

const describeClaim = ({ engine, runner, process, host }: Claim) =>
  `Claim: Engine ${engine}, ${runner === undefined ? 'no Runner yet' : `Runner ${runner}`}, process ${process}, host ${host}`;

const describeEscalation = ({ reason, attempts, worktree }: Escalation) =>
  `Escalation: ${reason}, ${attempts} ${attempts === 1 ? 'attempt' : 'attempts'}, Ticket Worktree ${worktree}`;

const describe = ({ claim, escalation }: TicketStatusLine): string | undefined =>
  claim !== undefined ? describeClaim(claim) : escalation !== undefined ? describeEscalation(escalation) : undefined;

const widest = (values: readonly string[]) => Math.max(0, ...values.map((value) => value.length));

// The printed lines: the identity, the Title, and the Ticket Status of each
// ticket, in aligned columns, then the owner of a Claim or the Escalation.
const formatStatusLines = (lines: readonly TicketStatusLine[]): readonly string[] => {
  const idWidth = widest(lines.map(({ ticket }) => ticket.id));
  const titleWidth = widest(lines.map(({ ticket }) => ticket.title));
  return lines.map((line) => {
    const detail = describe(line);
    const columns = [line.ticket.id.padEnd(idWidth), line.ticket.title.padEnd(titleWidth), line.status];
    return [...columns, ...(detail === undefined ? [] : [`(${detail})`])].join('  ').trimEnd();
  });
};

/** Prints one line for every ticket in scope, with its Ticket Status. */
export const showStatus = Effect.fn('status.show')(function* (command: ShowStatusCommand) {
  const lines = yield* ticketStatuses(command);
  if (lines.length === 0) {
    return yield* Console.log('No tickets are in scope');
  }
  yield* Effect.forEach(formatStatusLines(lines), (line) => Console.log(line), { discard: true });
});
