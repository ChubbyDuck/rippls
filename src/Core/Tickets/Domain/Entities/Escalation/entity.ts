import { Schema } from 'effect';

import { TicketId } from '../Ticket/properties/TicketId';

/**
 * The Ledger's record that a Ticket needs a human because its Ticket Processing
 * failed. It holds the reason, the attempt count, and the path of the retained
 * Ticket Worktree. An escalated Ticket is not Eligible.
 */
export class Escalation extends Schema.Class<Escalation>('Escalation')({
  ticket: TicketId,
  reason: Schema.NonEmptyString,
  attempts: Schema.Int.check(Schema.isGreaterThan(0)),
  worktree: Schema.NonEmptyString,
}) {}

/** What a failure gives the Ledger to record an Escalation. */
export type EscalationCause = Pick<Escalation, 'reason' | 'worktree'>;
