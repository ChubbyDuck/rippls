import { Data } from 'effect';

// A command could not be started or read in a worktree. A command that runs and
// exits with a non-zero code is no error: its exit code is the verdict.
export class WorktreeCommandError extends Data.TaggedError('WorktreeCommandError') {}
