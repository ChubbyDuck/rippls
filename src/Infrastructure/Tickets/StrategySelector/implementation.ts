import { Effect } from 'effect';

import { StrategyRuntimeError } from '~/Core/Tickets/Domain/Exceptions/StrategyRuntimeError';
import type { Strategy } from '~/Core/Tickets/Ports/Strategy';

import { gateCircumstances, worktreeCircumstances } from './circumstances';

// The harness prints one of these at the end of the gate run. The adapter matches
// the emitted substring and returns it as the completion signal.
const GATE_PASS = 'GATE:PASS';
const GATE_FAIL = 'GATE:FAIL';

// One gate attempt has this time limit. After a failed attempt the strategy
// retries once, so the gate runs at most twice.
const GATE_TIMEOUT = '10 minutes';
const GATE_RETRIES = 1;

const implementPromptOf = (body: string): string => `/implement-bare ${body}\n\n${worktreeCircumstances}`;

const gatePromptOf = (body: string): string =>
  `/acceptance-gate ${body}\n\n` +
  `${gateCircumstances}\n\n` +
  `When you finish, print exactly "${GATE_PASS}" if every gate passed. ` +
  `Otherwise print exactly "${GATE_FAIL}".`;

// Drives one implementation ticket: implement, then gate (with a limit and one
// retry). The Engine makes sure the work is committed afterwards. The port never
// fails, so every outcome is a Result value.
export const implementationStrategy: Strategy = {
  name: 'implementation',
  run: (ticket, harness) =>
    Effect.gen(function* () {
      yield* harness
        .run(implementPromptOf(ticket.body), { label: `ticket-${ticket.id}-implement` })
        .pipe(Effect.withSpan('strategy.implementation.implement'));

      yield* Effect.gen(function* () {
        const result = yield* harness
          .run(gatePromptOf(ticket.body), {
            label: `ticket-${ticket.id}-gate`,
            completionSignal: [GATE_PASS, GATE_FAIL],
          })
          .pipe(Effect.timeout(GATE_TIMEOUT));

        if (result.completionSignal !== GATE_PASS) {
          return yield* new StrategyRuntimeError();
        }
      }).pipe(Effect.retry({ times: GATE_RETRIES }), Effect.withSpan('strategy.implementation.gate'));
    }).pipe(
      Effect.mapError(() => new StrategyRuntimeError()),
      Effect.result
    ),
};
