import { Data } from 'effect';

/** How a step of a Strategy fails: a Harness error, its time limit, or a verdict other than pass. */
export type StepFailure = 'Harness error' | 'time limit reached' | 'verdict other than pass';

/**
 * A Strategy failed: the step at its position, counted from one, failed in the
 * given way on its last run. The message is the reason of the Escalation.
 */
export class StrategyRuntimeError extends Data.TaggedError('StrategyRuntimeError')<{
  readonly step: number;
  readonly failure: StepFailure;
}> {
  override get message(): string {
    return `strategy failure: step ${this.step}, ${this.failure}`;
  }
}
