import { Context, type Effect } from 'effect';

import type { EngineId } from '~/Core/Shared/Domain/Properties/EngineId';
import type { RunnerId } from '~/Core/Shared/Domain/Properties/RunnerId';
import type { Claim } from '~/Core/Tickets/Domain/Entities/Claim/entity';
import type { Escalation, EscalationCause } from '~/Core/Tickets/Domain/Entities/Escalation/entity';
import type { TicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';
import type { LedgerError } from '~/Core/Tickets/Domain/Exceptions/LedgerError';
import type { TicketAlreadyClaimed } from '~/Core/Tickets/Domain/Exceptions/TicketAlreadyClaimed';

/**
 * The Engine's own record of Ticket Processing, keyed by ticket identity. It is
 * local for every Ticket Source.
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
     * Removes the stale Claim while the Ledger still holds it. A Claim made on the
     * ticket since then stays in place.
     */
    readonly releaseStale: (claim: Claim) => Effect.Effect<void, LedgerError>;
    /** Removes every Claim that the Engine holds and returns the tickets it released. */
    readonly releaseAllOf: (engine: EngineId) => Effect.Effect<readonly TicketId[], LedgerError>;
    /** The Claims held on the given tickets. A ticket with no Claim is absent. */
    readonly read: (tickets: readonly TicketId[]) => Effect.Effect<ReadonlyMap<TicketId, Claim>, LedgerError>;
    /**
     * Records an Escalation of the ticket, with the reason and the path of the
     * retained Ticket Worktree. Each Escalation of the same ticket raises its
     * attempt count by one.
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
  }
>()('Ledger') {}
