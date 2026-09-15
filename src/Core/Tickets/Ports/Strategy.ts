import type { Effect, Result } from 'effect';

import type { Harness } from '~/Core/Shared/Ports/Harness';

import type { Ticket } from '../Domain/Entities/Ticket/entity';
import type { StrategyRuntimeError } from '../Domain/Exceptions/StrategyRuntimeError';

export interface Strategy {
  readonly name: string;
  // The port never fails. The outcome sits in the value as a Result, so the
  // caller decides what a success or a failure means.
  readonly run: (ticket: Ticket, harness: Harness) => Effect.Effect<Result.Result<void, StrategyRuntimeError>>;
}
