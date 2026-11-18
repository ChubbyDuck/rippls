import { Data, Duration } from 'effect';

// The Engine stayed Idle for the idle timeout it ran with.
export class EngineIdleTimeout extends Data.TaggedError('EngineIdleTimeout')<{
  readonly idleTimeout: Duration.Duration;
}> {
  override get message() {
    return `The Engine was Idle for ${Duration.format(this.idleTimeout)}. Engine is shutting down.`;
  }
}
