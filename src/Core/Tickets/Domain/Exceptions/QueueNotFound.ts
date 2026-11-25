import { Data } from 'effect';

/** No `.agents/tickets` queue exists at or above the start folder, up to the Repository Root. */
export class QueueNotFound extends Data.TaggedError('QueueNotFound')<{
  readonly start: string;
  readonly root: string;
}> {
  override get message(): string {
    return (
      `No .agents/tickets queue exists at or above ${this.start}, up to the Repository Root ${this.root}. ` +
      'Run `rippls init` to create one, or set `source.ticketsDir` in the config.'
    );
  }
}
