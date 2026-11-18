import { Schema } from 'effect';

import { TicketId } from '../Ticket/properties/TicketId';

/**
 * A Ticket raised to a human after its Ticket Processing failed, as the Ledger
 * records it. It holds the reason, the attempt count, and the path of the
 * retained Ticket Worktree. An escalated Ticket is not Eligible.
 */
export class Escalation extends Schema.Class<Escalation>('Escalation')({
  ticket: TicketId,
  reason: Schema.NonEmptyString,
  attempts: Schema.Int.check(Schema.isGreaterThan(0)),
  worktree: Schema.NonEmptyString,
}) {}
