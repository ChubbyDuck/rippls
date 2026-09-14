import { Data } from 'effect';

export class HarnessIdleTimeout extends Data.TaggedError('HarnessIdleTimeout') {
  override readonly message = 'The Harness was Idle for five minutes. Harness is shutting down.';
}
