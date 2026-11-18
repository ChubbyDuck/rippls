import { Effect } from 'effect';

import type { Claim } from '~/Core/Tickets/Domain/Entities/Claim/entity';

/** The process and the host that every Claim of a Ledger adapter names. */
export type ClaimHolder = {
  readonly process: number;
  readonly host: string;
};

/**
 * The stale-Claim rule of a Ledger adapter: a Claim is stale when its process no
 * longer runs on the holder's host. A Claim from another host is never stale,
 * since the processes of another host cannot be seen.
 */
export const isStaleFor =
  (holder: ClaimHolder, processRuns: (process: number) => Effect.Effect<boolean>) =>
  (claim: Claim): Effect.Effect<boolean> =>
    claim.host === holder.host ? processRuns(claim.process).pipe(Effect.map((runs) => !runs)) : Effect.succeed(false);
