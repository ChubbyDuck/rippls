import { Console, Effect } from 'effect';

import { outstandingBlockers } from '~/Core/Tickets/Application/Services/outstandingBlockers';
import { readTicketScope } from '~/Core/Tickets/Application/Services/ticketScope';
import type { Project } from '~/Core/Tickets/Domain/Entities/Ticket/properties/Project';
import type { UnreadableTicket } from '~/Core/Tickets/Domain/Entities/UnreadableTicket/entity';
import { TicketSource } from '~/Core/Tickets/Ports/TicketSource';

const labelOf = ({ id, name }: UnreadableTicket) => (id === undefined ? name : `${id} (${name})`);

const hasNoNumber = ({ reason }: UnreadableTicket) => reason === 'no numeric prefix';

// A folder holds tickets of its own, so none of them is taken; a file is one ticket.
const unreadableLine = (ticket: UnreadableTicket) =>
  ticket.reason === 'folder cannot be read'
    ? `${labelOf(ticket)} is unreadable, so none of its tickets is taken: ${ticket.explanation}`
    : `${labelOf(ticket)} is unreadable and is not taken: ${ticket.explanation}`;

const withoutNumberLine = (count: number) =>
  count === 1
    ? '1 file has no numeric prefix, so it is not read as a ticket'
    : `${count} files have no numeric prefix, so they are not read as tickets`;

/**
 * Prints, at Engine start, what the Engine cannot read and will not take: one line
 * for each unreadable ticket or folder with its reason, one line for each unresolved blocker
 * of a ticket in scope with the ticket and the reference, and one line with the
 * count of files without a numeric prefix.
 */
export const reportUnreadable = (project?: Project) =>
  Effect.gen(function* () {
    const source = yield* TicketSource;
    const unreadable = yield* source.getUnreadable;
    const blockers = yield* readTicketScope(project).pipe(Effect.map(outstandingBlockers));
    const withoutNumber = unreadable.filter(hasNoNumber);
    const lines = [
      ...unreadable.filter((ticket) => !hasNoNumber(ticket)).map(unreadableLine),
      ...[...blockers].flatMap(([ticket, { unresolved }]) =>
        unresolved.map((blocker) => `${ticket} has a blocker that cannot be resolved, so it stays blocked: ${blocker}`)
      ),
      ...(withoutNumber.length === 0 ? [] : [withoutNumberLine(withoutNumber.length)]),
    ];
    yield* Effect.forEach(lines, (line) => Console.warn(line), { discard: true });
  });
