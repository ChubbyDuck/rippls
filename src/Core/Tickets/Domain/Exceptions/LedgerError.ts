import { Data } from 'effect';

export class LedgerError extends Data.TaggedError('LedgerError')<{
  readonly cause: unknown;
}> {}
