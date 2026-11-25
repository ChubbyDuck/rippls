import { Data } from 'effect';

/** A Concurrency above one with the in-place Workspace, which allows one Runner. */
export class ConcurrencyNotInPlace extends Data.TaggedError('ConcurrencyNotInPlace')<{
  readonly concurrency: number;
}> {
  override get message(): string {
    return (
      `The in-place Workspace allows a Concurrency of one, and the Concurrency is ${this.concurrency}: ` +
      'two Agents would share one checkout. Set `workspace: worktree` in the config to run Tickets in parallel ' +
      'in Ticket Worktrees, or run with `--concurrency 1`.'
    );
  }
}
