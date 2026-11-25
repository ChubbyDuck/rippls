import { Data } from 'effect';

/**
 * The Repository Root has uncommitted changes before a ticket in place, which an
 * Agent working there would commit with its own work.
 */
export class RepositoryRootDirty extends Data.TaggedError('RepositoryRootDirty')<{
  readonly root: string;
  readonly paths: ReadonlyArray<string>;
}> {
  override get message(): string {
    return (
      `The Repository Root ${this.root} has uncommitted changes, which an Agent working in place would commit:\n` +
      this.paths.map((path) => `  ${path}\n`).join('') +
      'Commit or stash them before the next ticket.'
    );
  }
}
