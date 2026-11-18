import { Context, type Effect } from 'effect';

import type { EngineId } from '~/Core/Shared/Domain/Properties/EngineId';
import type { RunnerId } from '~/Core/Shared/Domain/Properties/RunnerId';
import type { Claim } from '~/Core/Tickets/Domain/Entities/Claim/entity';
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
    /** Removes every Claim that the Engine holds and returns the tickets it released. */
    readonly releaseAllOf: (engine: EngineId) => Effect.Effect<readonly TicketId[], LedgerError>;
    /** The Claims held on the given tickets. A ticket with no Claim is absent. */
    readonly read: (tickets: readonly TicketId[]) => Effect.Effect<ReadonlyMap<TicketId, Claim>, LedgerError>;
  }
>()('Ledger') {}
