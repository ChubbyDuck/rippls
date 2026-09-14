import { Data } from 'effect';

export class WorktreesNotWritable extends Data.TaggedError('WorktreesNotWritable')<{
  readonly path: string;
}> {
  override get message() {
    return `chmod u+w ${this.path}`;
  }
}
