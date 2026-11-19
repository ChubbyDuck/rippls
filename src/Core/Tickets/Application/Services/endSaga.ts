import { Effect } from 'effect';

import type { TicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';
import { Ledger } from '~/Core/Tickets/Ports/Ledger';
import { TicketSource } from '~/Core/Tickets/Ports/TicketSource';

/**
 * Ends the saga of a Claim (ADR 0004). The end state follows the Ledger: done
 * completes the ticket on the Source, escalated reports escalated, and otherwise
 * the Claim is released. The record leaves the Ledger only after the Source
 * accepts the report; when the report fails, the record stays, and a later Engine
 * that meets it as a Stale Claim ends the saga.
 */
export const endSaga = (ticket: TicketId) =>
  Effect.gen(function* () {
    const ledger = yield* Ledger;
    const source = yield* TicketSource;
    const done = yield* ledger.done([ticket]);
    const escalations = yield* ledger.escalations([ticket]);
    const event = done.has(ticket) ? 'done' : escalations.has(ticket) ? 'escalated' : 'released';
    yield* source.report(ticket, event);
    yield* ledger.release(ticket);
  });
