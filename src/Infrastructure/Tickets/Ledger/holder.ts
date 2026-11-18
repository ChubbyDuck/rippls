/** The process and the host that every Claim of a Ledger adapter names. */
export type ClaimHolder = {
  readonly process: number;
  readonly host: string;
};
