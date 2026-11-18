import { Data } from 'effect';

// A directory on disk where a Project Worktree or a Ticket Worktree belongs is not
// the Git worktree on the expected branch, so it is not reused.
export class WorktreeNotExpected extends Data.TaggedError('WorktreeNotExpected')<{
  readonly path: string;
  readonly expectedBranch: string;
  readonly found: string;
}> {
  override get message() {
    return `${this.path} is expected to be a Git worktree on branch ${this.expectedBranch}, but it is ${this.found}`;
  }
}
