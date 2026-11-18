import type { Claim } from '~/Core/Tickets/Domain/Entities/Claim/entity';

/** The process and the host that every Claim of a Ledger adapter names. */
export type ClaimHolder = {
  readonly process: number;
  readonly host: string;
};

/**
 * Whether two records are one Claim: made by the same Engine, process, and host.
 * The Runner a Claim gains later does not make it another Claim.
 */
export const isSameClaim = (a: Claim, b: Claim): boolean =>
  a.ticket === b.ticket && a.engine === b.engine && a.process === b.process && a.host === b.host;
