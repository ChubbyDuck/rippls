import { Effect } from 'effect';

import type { Ticket } from '~/Core/Tickets/Domain/Entities/Ticket/entity';
import { StrategyRuntimeError } from '~/Core/Tickets/Domain/Exceptions/StrategyRuntimeError';
import type { Strategy } from '~/Core/Tickets/Ports/Strategy';

import { gateCircumstances, worktreeCircumstances } from './circumstances';

// The agent prints one of these at the end of the gate run. The adapter matches
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

const commitPromptOf = (ticket: Ticket): string =>
  ticket.project === undefined ? `/commit ticket-${ticket.id}` : `/commit ${ticket.project} ticket-${ticket.id}`;

// Drives one implementation ticket: implement, gate (with a limit and one
// retry), then commit. The port never fails, so every outcome is a Result value.
export const implementationStrategy: Strategy = {
  name: 'implementation',
  run: (ticket, agent) =>
    Effect.gen(function* () {
      yield* agent
        .run(implementPromptOf(ticket.body), { label: `ticket-${ticket.id}-implement` })
        .pipe(Effect.withSpan('strategy.implementation.implement'));

      yield* Effect.gen(function* () {
        const result = yield* agent
          .run(gatePromptOf(ticket.body), {
            label: `ticket-${ticket.id}-gate`,
            completionSignal: [GATE_PASS, GATE_FAIL],
          })
          .pipe(Effect.timeout(GATE_TIMEOUT));

        if (result.completionSignal !== GATE_PASS) {
          return yield* new StrategyRuntimeError();
        }
      }).pipe(Effect.retry({ times: GATE_RETRIES }), Effect.withSpan('strategy.implementation.gate'));

      yield* agent
        .run(commitPromptOf(ticket), { label: `ticket-${ticket.id}-commit`, model: { fast: true, tier: 'low' } })
        .pipe(Effect.withSpan('strategy.implementation.commit'));
    }).pipe(
      Effect.mapError(() => new StrategyRuntimeError()),
      Effect.result
    ),
};
