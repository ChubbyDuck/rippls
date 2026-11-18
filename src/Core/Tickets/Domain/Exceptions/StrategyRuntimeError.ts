import { Data } from 'effect';

/** How a step of a Strategy fails: a Harness error, its time limit, or a verdict other than pass. */
export type StepFailure = 'Harness error' | 'time limit' | 'verdict';

const failureText: Record<StepFailure, string> = {
  'Harness error': 'Harness error',
  'time limit': 'time limit reached',
  verdict: 'verdict other than pass',
};

/** A Strategy failed: the step at its position, counted from one, failed in the given way. */
export class StrategyRuntimeError extends Data.TaggedError('StrategyRuntimeError')<{
  readonly step: number;
  readonly failure: StepFailure;
}> {
  /** The reason of the Escalation: the step that failed, by its position, and how it failed. */
  get reason(): string {
    return `strategy failure: step ${this.step}, ${failureText[this.failure]}`;
  }
}
