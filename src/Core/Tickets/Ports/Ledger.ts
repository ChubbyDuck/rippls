import { Context, type Effect } from 'effect';

import type { EngineId } from '~/Core/Shared/Domain/Properties/EngineId';
import type { RunnerId } from '~/Core/Shared/Domain/Properties/RunnerId';
import type { Claim } from '~/Core/Tickets/Domain/Entities/Claim/entity';
import type { Escalation, EscalationCause } from '~/Core/Tickets/Domain/Entities/Escalation/entity';
import type { TicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';
import type { LedgerError } from '~/Core/Tickets/Domain/Exceptions/LedgerError';
import type { TicketAlreadyClaimed } from '~/Core/Tickets/Domain/Exceptions/TicketAlreadyClaimed';

/**
 * The Engine's own record of Ticket Processing, keyed by ticket identity: Claims,
 * Escalations, and done. It is local for every Ticket Source.
 */
export class Ledger extends Context.Service<
  Ledger,
  {
    /** Makes a Claim for the Engine. Only one caller can claim a ticket; every other one fails. */
    readonly claim: (ticket: TicketId, engine: EngineId) => Effect.Effect<Claim, TicketAlreadyClaimed | LedgerError>;
    /** Names the Runner that starts Ticket Processing in the ticket's Claim. */
    readonly assignRunner: (ticket: TicketId, runner: RunnerId) => Effect.Effect<void, LedgerError>;
    /** Removes the ticket's Claim. Releasing a ticket that has no Claim does nothing. */
    readonly release: (ticket: TicketId) => Effect.Effect<void, LedgerError>;
    /**
     * Whether the Claim is stale: its process no longer runs on this host. A Claim
     * from another host is never stale.
     */
    readonly isStale: (claim: Claim) => Effect.Effect<boolean>;
    /**
     * Turns the Stale Claim into a new Claim of the Engine, in one write of the
     * ticket's record, and tells whether this caller did. Of several callers that
     * replace one Stale Claim, only one wins; a Claim made on the ticket since the
     * Stale Claim was read stays in place. The Ledger holds a Claim on the ticket
     * at every point, a failed replace included.
     */
    readonly replaceStale: (stale: Claim, engine: EngineId) => Effect.Effect<boolean, LedgerError>;
    /** The tickets on which the Engine holds a Claim. */
    readonly ticketsClaimedBy: (engine: EngineId) => Effect.Effect<readonly TicketId[], LedgerError>;
    /** The Claims held on the given tickets. A ticket with no Claim is absent. */
    readonly read: (tickets: readonly TicketId[]) => Effect.Effect<ReadonlyMap<TicketId, Claim>, LedgerError>;
    /**
     * Records an Escalation of the ticket, with the reason and the path of the
     * retained Ticket Worktree, if any. Each Escalation of the same ticket raises
     * its attempt count by one.
     */
    readonly escalate: (ticket: TicketId, cause: EscalationCause) => Effect.Effect<Escalation, LedgerError>;
    /**
     * Clears the ticket's Escalation, so the ticket is no longer escalated. The
     * attempt count is kept: the next Escalation of the ticket raises it.
     * Clearing a ticket that is not escalated does nothing.
     */
    readonly clearEscalation: (ticket: TicketId) => Effect.Effect<void, LedgerError>;
    /** The Escalations of the given tickets. A ticket that is not escalated is absent. */
    readonly escalations: (
      tickets: readonly TicketId[]
    ) => Effect.Effect<ReadonlyMap<TicketId, Escalation>, LedgerError>;
    /**
     * Records that the ticket is done, once its work is merged. Done never
     * reverts. Recording a ticket that is already done does nothing.
     */
    readonly recordDone: (ticket: TicketId) => Effect.Effect<void, LedgerError>;
    /** The given tickets that the Ledger records as done. */
    readonly done: (tickets: readonly TicketId[]) => Effect.Effect<ReadonlySet<TicketId>, LedgerError>;
  }
>()('Ledger') {}
