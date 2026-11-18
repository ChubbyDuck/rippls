import { Effect, Layer } from 'effect';

import { type StrategiesConfig, type StrategyStep, strategiesConfig } from '~/Core/Shared/Domain/EngineConfig';
import type { Harness, HarnessRunOptions } from '~/Core/Shared/Ports/Harness';
import type { Ticket } from '~/Core/Tickets/Domain/Entities/Ticket/entity';
import type { TicketKind } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketKind';
import { StrategyNotFound } from '~/Core/Tickets/Domain/Exceptions/StrategyNotFound';
import { StrategyRuntimeError } from '~/Core/Tickets/Domain/Exceptions/StrategyRuntimeError';
import { renderPrompt } from '~/Core/Tickets/Domain/Services/promptTemplate';
import type { Strategy } from '~/Core/Tickets/Ports/Strategy';
import { StrategySelector } from '~/Core/Tickets/Ports/StrategySelector';

import { VERDICT_FAIL, VERDICT_PASS, verdictInstruction, worktreeCircumstances } from './circumstances';

// The prompt of a step for the selected Harness: its own prompt when the step has
// one, and the general prompt otherwise. The Engine appends the facts it arranged,
// and for a verdict step the signals it reads back.
const promptOf = (step: StrategyStep, ticket: Ticket, harness: Harness): string => {
  const prompts: Readonly<Record<string, string | undefined>> = step.prompts ?? {};
  const prompt = `${renderPrompt(prompts[harness.name] ?? step.prompt, ticket)}\n\n${worktreeCircumstances}`;
  return step.verdict === true ? `${prompt}\n\n${verdictInstruction}` : prompt;
};

const optionsOf = (step: StrategyStep, ticket: Ticket, index: number): HarnessRunOptions => ({
  label: `ticket-${ticket.id}-step-${index + 1}`,
  ...(step.model === undefined ? {} : { model: step.model }),
  ...(step.verdict === true ? { completionSignal: [VERDICT_PASS, VERDICT_FAIL] } : {}),
});

// One step: a Harness run within the time limit and, for a verdict step, the pass
// signal. Anything else fails the step, which runs again up to its retry count.
const runStep = (step: StrategyStep, ticket: Ticket, harness: Harness, index: number) => {
  const run = harness.run(promptOf(step, ticket, harness), optionsOf(step, ticket, index));
  return (step.timeLimit === undefined ? run : run.pipe(Effect.timeout(step.timeLimit))).pipe(
    Effect.filterOrFail(
      (result) => step.verdict !== true || result.completionSignal === VERDICT_PASS,
      () => new StrategyRuntimeError()
    ),
    Effect.retry({ times: step.retries ?? 0 }),
    Effect.withSpan('strategy.step', { attributes: { step: index + 1, verdict: step.verdict === true } })
  );
};

// The Strategy of a Ticket Kind, named after it. It runs the steps in order in
// the same Ticket Worktree. A failed step fails the Strategy and runs no further
// step. The port never fails, so every outcome is a Result value.
export const configuredStrategy = (kind: TicketKind, steps: readonly StrategyStep[]): Strategy => ({
  name: kind,
  run: (ticket, harness) =>
    Effect.forEach(steps, (step, index) => runStep(step, ticket, harness, index), { discard: true }).pipe(
      Effect.mapError(() => new StrategyRuntimeError()),
      Effect.result
    ),
});

const strategySelectorOf = (strategies: StrategiesConfig): StrategySelector['Service'] => ({
  select: (kind) => {
    const steps = strategies[kind];
    return steps === undefined ? Effect.fail(new StrategyNotFound({ kind })) : Effect.succeed(configuredStrategy(kind, steps));
  },
});

// Selects the configured Strategy of a Ticket Kind: the default, or the one config sets.
export const StrategySelectorLive = Layer.effect(StrategySelector, Effect.map(strategiesConfig, strategySelectorOf));
