import type { Ticket } from '~/Core/Tickets/Domain/Entities/Ticket/entity';
import type { TicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';

/** A Ticket that its Source sees as done: in `done/`, or completed on Linear. */
export const isDoneInSource = (ticket: Ticket): boolean => ticket.doneInSource;

/** The identities of the Tickets among the tickets a Source returned that it sees as done. */
export const doneInSourceIds = (tickets: readonly Ticket[]): ReadonlySet<TicketId> =>
  new Set(tickets.filter(isDoneInSource).map((ticket) => ticket.id));

/**
 * A Ticket whose work has landed: its Source sees it as done, or it is among the
 * done tickets, which hold the tickets the Source sees as done and the ones the
 * Ledger records as done. Neither fact reverts. A done Ticket is never Eligible.
 */
export const isDone = (ticket: Ticket, done: ReadonlySet<TicketId>): boolean =>
  isDoneInSource(ticket) || done.has(ticket.id);

/**
 * A Ticket whose blockers are all done. A blocker that is not among the done
 * tickets, because it is not done or because the Source cannot find it, blocks.
 */
export const isUnblocked = (ticket: Ticket, done: ReadonlySet<TicketId>): boolean =>
  ticket.blockedBy.every((blocker) => done.has(blocker));

/**
 * A Ticket with no Claim in the Ledger other than a Stale Claim, which its Source
 * does not see as claimed. A ticket its Source sees as claimed is Unclaimed only
 * when this host's Ledger holds a Stale Claim on it: the Claim on the Source is
 * then the one a stopped Engine left, which the Engine replaces.
 */
export const isUnclaimed = (ticket: Ticket, { claimed, stale }: Pick<EligibilityFacts, 'claimed' | 'stale'>): boolean =>
  !claimed.has(ticket.id) && (!ticket.claimedInSource || stale.has(ticket.id));

/** A Ticket that has an Escalation in the Ledger. */
export const isEscalated = (ticket: Ticket, escalated: ReadonlySet<TicketId>): boolean => escalated.has(ticket.id);

/** A Ticket whose HITL is no, allowing it to proceed without a human. */
export const isUnattended = (ticket: Ticket): boolean => ticket.hitl === 'no';

/**
 * What the Engine knows of other tickets: which are done, as their Source sees them
 * or as the Ledger records them, which hold a Claim in the Ledger that is not a
 * Stale Claim, which hold a Stale Claim in the Ledger, and which have an Escalation
 * in the Ledger.
 */
export type EligibilityFacts = {
  readonly done: ReadonlySet<TicketId>;
  readonly claimed: ReadonlySet<TicketId>;
  readonly stale: ReadonlySet<TicketId>;
  readonly escalated: ReadonlySet<TicketId>;
};

/**
 * The one eligibility rule of the Engine: an Unblocked, Unclaimed, Unattended
 * Ticket that is not done or escalated, which the Engine may take next. A Ticket
 * Source returns every ticket in scope, done ones included, and the Ledger holds
 * the Claims and Escalations; this rule decides which of the tickets the Engine
 * may take.
 */
export const isEligible = (ticket: Ticket, facts: EligibilityFacts): boolean =>
  !isDone(ticket, facts.done) &&
  !isEscalated(ticket, facts.escalated) &&
  isUnblocked(ticket, facts.done) &&
  isUnclaimed(ticket, facts) &&
  isUnattended(ticket);
