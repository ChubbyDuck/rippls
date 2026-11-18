import { Data } from 'effect';

export class FixtureNotWritten extends Data.TaggedError('FixtureNotWritten')<{ readonly cause: unknown }> {}
