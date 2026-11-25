import { Schema } from 'effect';

import { EngineId } from '~/Core/Shared/Domain/Properties/EngineId';
import { RunnerId } from '~/Core/Shared/Domain/Properties/RunnerId';

import { TicketId } from '../Ticket/properties/TicketId';

/**
 * The exclusive assignment of a Ticket to an Engine, as the Ledger records it.
 * It names the Engine, the process, and the host that made it, and gains the
 * Runner when a Runner starts Ticket Processing.
 */
export class Claim extends Schema.Class<Claim>('Claim')({
  ticket: TicketId,
  engine: EngineId,
  process: Schema.Int.check(Schema.isGreaterThan(0)),
  host: Schema.NonEmptyString,
  runner: Schema.optionalKey(RunnerId),
}) {
  /**
   * Whether the other record is this Claim: on the same ticket, made by the same
   * Engine, process, and host. The Runner a Claim gains later does not make it
   * another Claim.
   */
  isSameClaim(other: Claim): boolean {
    return (
      this.ticket === other.ticket &&
      this.engine === other.engine &&
      this.process === other.process &&
      this.host === other.host
    );
  }

  withRunner(runner: RunnerId): Claim {
    return Claim.make({ ticket: this.ticket, engine: this.engine, process: this.process, host: this.host, runner });
  }
}
