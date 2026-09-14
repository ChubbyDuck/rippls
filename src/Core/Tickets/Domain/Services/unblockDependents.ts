import type { Ticket } from '~/Core/Tickets/Domain/Entities/Ticket/entity';
import type { TicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';

/**
 * The domain rule for one completed ticket: every candidate that the completed
 * ticket blocked loses that blocker. A candidate with no blockers left becomes
 * ready. The function is pure. It reads no repository and it returns only the
 * candidates that changed.
 */
export const unblockDependents = (completedId: TicketId, candidates: readonly Ticket[]): readonly Ticket[] =>
  candidates.filter((candidate) => candidate.isBlockedBy(completedId)).map((candidate) => candidate.unblockedBy(completedId));
