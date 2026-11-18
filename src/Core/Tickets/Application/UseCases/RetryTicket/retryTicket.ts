import { Console, Effect } from 'effect';

import { TicketNotEscalated } from '~/Core/Tickets/Domain/Exceptions/TicketNotEscalated';
import { Ledger } from '~/Core/Tickets/Ports/Ledger';
import { TicketSource } from '~/Core/Tickets/Ports/TicketSource';

import type { RetryTicketCommand } from './command';

/**
 * Returns an escalated ticket to unattended processing. The Source hears retried,
 * then the Ledger clears the Escalation and keeps its attempt count. The next
 * Engine run takes the ticket and continues in its retained Ticket Worktree.
 *
 * The Source hears first: a Source may show the ticket as not ready until it hears
 * retried, so a report that fails leaves the Escalation in place for another retry.
 */
export const retryTicket = Effect.fn('ticket.retry')(function* ({ ticket }: RetryTicketCommand) {
  const ledger = yield* Ledger;
  const source = yield* TicketSource;
  const escalation = (yield* ledger.escalations([ticket])).get(ticket);
  if (escalation === undefined) {
    return yield* new TicketNotEscalated({ ticketId: ticket });
  }
  yield* source.report(ticket, 'retried');
  yield* ledger.clearEscalation(ticket);
  const { attempts, worktree } = escalation;
  yield* Console.log(
    `${ticket} is retried after ${attempts} ${attempts === 1 ? 'attempt' : 'attempts'}; the next Engine run continues in its Ticket Worktree at ${worktree}`
  );
});
