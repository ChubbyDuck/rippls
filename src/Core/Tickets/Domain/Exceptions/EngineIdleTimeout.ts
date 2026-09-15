import { Data } from 'effect';

export class EngineIdleTimeout extends Data.TaggedError('EngineIdleTimeout') {
  override readonly message = 'The Engine was Idle for five minutes. Engine is shutting down.';
}
