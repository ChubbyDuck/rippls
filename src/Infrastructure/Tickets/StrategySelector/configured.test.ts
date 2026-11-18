import { ConfigProvider, Duration, Effect, Fiber, Layer, Option, Result } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, test } from 'vitest';

import { defaultStrategies, engineConfigProvider, type StrategyStep } from '~/Core/Shared/Domain/EngineConfig';
import { HarnessRuntimeError } from '~/Core/Shared/Domain/Exceptions/HarnessRuntimeError';
import type { Harness, HarnessRunOptions, HarnessRunResult } from '~/Core/Shared/Ports/Harness';
import { Ticket } from '~/Core/Tickets/Domain/Entities/Ticket/entity';
import { formatTicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';
import { StrategyNotFound } from '~/Core/Tickets/Domain/Exceptions/StrategyNotFound';
import { StrategyRuntimeError } from '~/Core/Tickets/Domain/Exceptions/StrategyRuntimeError';
import { StrategySelector } from '~/Core/Tickets/Ports/StrategySelector';

import { verdictInstruction, worktreeCircumstances } from './circumstances';
import { configuredStrategy, StrategySelectorLive } from './configured';

const ticket = Ticket.create({
  id: formatTicketId('folder', '7'),
  title: 'Deliver a green ticket',
  project: 'web',
  kind: 'implementation',
  blockedBy: [],
  body: 'BODY',
});

type Handler = (prompt: string, options: HarnessRunOptions) => Effect.Effect<HarnessRunResult, HarnessRuntimeError>;

type Call = { readonly prompt: string; readonly options: HarnessRunOptions };

const harnessOf = (handler: Handler, name = 'Claude'): { harness: Harness; calls: Call[] } => {
  const calls: Call[] = [];
  const harness: Harness = {
    name,
    model: 'test-model',
    run: (prompt, options) =>
      Effect.suspend(() => {
        calls.push({ prompt, options });
        return handler(prompt, options);
      }),
  };
  return { harness, calls };
};

const succeeding: Handler = () => Effect.succeed({ completionSignal: undefined });

// A verdict step reads these signals in turn; every other step emits none.
const verdicts = (signals: (string | undefined)[]): Handler => {
  let index = 0;
  return (_prompt, options) =>
    Effect.succeed({ completionSignal: options.completionSignal === undefined ? undefined : signals[index++] });
};

const run = (steps: readonly StrategyStep[], harness: Harness) =>
  Effect.runPromise(configuredStrategy('implementation', steps).run(ticket, harness));

// The reason of the Escalation that a failed Strategy causes.
const reasonOf = (outcome: Result.Result<void, StrategyRuntimeError>) =>
  Result.getFailure(outcome).pipe(Option.map((error) => error.message));

const verdictStep: StrategyStep = { prompt: 'Judge {{id}}.', verdict: true, retries: 1 };

test('the Harness receives the rendered prompts in order, each with its own model demand', async () => {
  const { harness, calls } = harnessOf(succeeding);

  const outcome = await run(
    [
      { prompt: 'Implement {{id}} of {{project}}: {{title}}\n\n{{body}}', model: { tier: 'high' } },
      { prompt: 'Review {{title}}.', model: { fast: true, tier: 'low' } },
      { prompt: 'Summarize.' },
    ],
    harness
  );

  expect(Result.isSuccess(outcome)).toBe(true);
  expect(calls).toEqual([
    {
      prompt: `Implement folder:7 of web: Deliver a green ticket\n\nBODY\n\n${worktreeCircumstances}`,
      options: { label: 'ticket-folder:7-step-1', model: { tier: 'high' } },
    },
    {
      prompt: `Review Deliver a green ticket.\n\n${worktreeCircumstances}`,
      options: { label: 'ticket-folder:7-step-2', model: { fast: true, tier: 'low' } },
    },
    { prompt: `Summarize.\n\n${worktreeCircumstances}`, options: { label: 'ticket-folder:7-step-3' } },
  ]);
});

test('a step sends its prompt for the selected Harness, and the general prompt to any other Harness', async () => {
  const steps: StrategyStep[] = [{ prompt: 'Implement {{id}}.', prompts: { Claude: '/implement {{id}}', Codex: '$implement {{id}}' } }];
  const claude = harnessOf(succeeding, 'Claude');
  const cursor = harnessOf(succeeding, 'Cursor');

  await run(steps, claude.harness);
  await run(steps, cursor.harness);

  expect(claude.calls.map((call) => call.prompt)).toEqual([`/implement folder:7\n\n${worktreeCircumstances}`]);
  expect(cursor.calls.map((call) => call.prompt)).toEqual([`Implement folder:7.\n\n${worktreeCircumstances}`]);
});

test('a verdict step asks for the signals, and a pass continues to the next step', async () => {
  const { harness, calls } = harnessOf(verdicts(['VERDICT:PASS']));

  const outcome = await run([verdictStep, { prompt: 'After.' }], harness);

  expect(Result.isSuccess(outcome)).toBe(true);
  expect(calls).toEqual([
    {
      prompt: `Judge folder:7.\n\n${worktreeCircumstances}\n\n${verdictInstruction}`,
      options: { label: 'ticket-folder:7-step-1', completionSignal: ['VERDICT:PASS', 'VERDICT:FAIL'] },
    },
    { prompt: `After.\n\n${worktreeCircumstances}`, options: { label: 'ticket-folder:7-step-2' } },
  ]);
});

test('a failed verdict runs the step again, and a pass on the retry succeeds', async () => {
  const { harness, calls } = harnessOf(verdicts(['VERDICT:FAIL', 'VERDICT:PASS']));

  const outcome = await run([verdictStep], harness);

  expect(Result.isSuccess(outcome)).toBe(true);
  expect(calls.map((call) => call.options.label)).toEqual(['ticket-folder:7-step-1', 'ticket-folder:7-step-1']);
});

test('a verdict that is not a pass after every retry fails the Strategy and runs no further step', async () => {
  const { harness, calls } = harnessOf(verdicts(['VERDICT:FAIL', undefined, 'VERDICT:PASS']));

  const outcome = await run([{ prompt: 'Before.' }, verdictStep, { prompt: 'After.' }], harness);

  expect(outcome).toEqual(Result.fail(new StrategyRuntimeError({ step: 2, failure: 'verdict other than pass' })));
  expect(reasonOf(outcome)).toEqual(Option.some('strategy failure: step 2, verdict other than pass'));
  expect(calls.map((call) => call.options.label)).toEqual([
    'ticket-folder:7-step-1',
    'ticket-folder:7-step-2',
    'ticket-folder:7-step-2',
  ]);
});

test('a verdict step with no retry count fails on the first verdict that is not a pass', async () => {
  const { harness, calls } = harnessOf(verdicts(['VERDICT:FAIL']));

  const outcome = await run([{ prompt: 'Judge.', verdict: true }], harness);

  expect(outcome).toEqual(Result.fail(new StrategyRuntimeError({ step: 1, failure: 'verdict other than pass' })));
  expect(calls).toHaveLength(1);
});

test('the time limit ends a step, which then counts as failed', async () => {
  const { harness, calls } = harnessOf((_prompt, options) =>
    options.completionSignal === undefined ? Effect.succeed({ completionSignal: undefined }) : Effect.never
  );

  const outcome = await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* configuredStrategy('implementation', [
        { prompt: 'Before.' },
        { prompt: 'Judge.', verdict: true, timeLimit: Duration.minutes(10), retries: 1 },
        { prompt: 'After.' },
      ])
        .run(ticket, harness)
        .pipe(Effect.forkChild);
      yield* TestClock.adjust('10 minutes');
      yield* TestClock.adjust('10 minutes');
      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestClock.layer()))
  );

  expect(outcome).toEqual(Result.fail(new StrategyRuntimeError({ step: 2, failure: 'time limit reached' })));
  expect(reasonOf(outcome)).toEqual(Option.some('strategy failure: step 2, time limit reached'));
  expect(calls.map((call) => call.options.label)).toEqual([
    'ticket-folder:7-step-1',
    'ticket-folder:7-step-2',
    'ticket-folder:7-step-2',
  ]);
});

test('a Harness error fails the Strategy and runs no further step', async () => {
  const { harness, calls } = harnessOf((prompt) =>
    prompt.startsWith('Implement.') ? Effect.fail(new HarnessRuntimeError()) : Effect.succeed({ completionSignal: undefined })
  );

  const outcome = await run([{ prompt: 'Before.' }, { prompt: 'Implement.' }, { prompt: 'After.' }], harness);

  expect(outcome).toEqual(Result.fail(new StrategyRuntimeError({ step: 2, failure: 'Harness error' })));
  expect(reasonOf(outcome)).toEqual(Option.some('strategy failure: step 2, Harness error'));
  expect(calls).toHaveLength(2);
});

// Selects the Strategy of a Ticket Kind and runs it, so the test sees its prompts.
const selectAndRun = (entries: Record<string, unknown>, kind: Ticket['kind']) => {
  const { harness, calls } = harnessOf(verdicts(['VERDICT:PASS']));
  return Effect.runPromise(
    StrategySelector.use((selector) => selector.select(kind)).pipe(
      Effect.tap((strategy) => strategy.run(ticket, harness)),
      Effect.map((strategy) => ({ name: strategy.name, prompts: calls.map((call) => call.prompt) })),
      Effect.provide(StrategySelectorLive.pipe(Layer.provide(ConfigProvider.layer(engineConfigProvider(entries))))),
      Effect.result
    )
  );
};

test('with no Strategies configured, the defaults run: implement and a verdict for implementation, one step for research and task', async () => {
  const implementation = Result.getOrThrow(await selectAndRun({}, 'implementation'));
  const research = Result.getOrThrow(await selectAndRun({}, 'research'));
  const task = Result.getOrThrow(await selectAndRun({}, 'task'));

  expect(implementation.name).toBe('implementation');
  expect(implementation.prompts).toHaveLength(2);
  expect(implementation.prompts[1]).toContain(verdictInstruction);
  expect(research.prompts).toHaveLength(1);
  expect(task.prompts).toHaveLength(1);
  for (const prompt of [...implementation.prompts, ...research.prompts, ...task.prompts]) {
    expect(prompt).toContain('Ticket folder:7: Deliver a green ticket\n\nBODY');
  }
});

test('no prompt in the default Strategies starts with a slash command', () => {
  const steps = Object.values(defaultStrategies).flat();

  expect(steps.length).toBeGreaterThan(0);
  for (const step of steps) {
    expect(step.prompt.trimStart()).not.toMatch(/^\//);
    expect(step.prompts).toBeUndefined();
  }
});

test('a configured Strategy for a Ticket Kind replaces the default for that Kind and keeps the others', async () => {
  const strategies = { implementation: [{ prompt: '/tdd {{id}}' }] };

  const implementation = Result.getOrThrow(await selectAndRun({ strategies }, 'implementation'));
  const research = Result.getOrThrow(await selectAndRun({ strategies }, 'research'));

  expect(implementation.prompts).toEqual([`/tdd folder:7\n\n${worktreeCircumstances}`]);
  expect(research.prompts).toEqual(Result.getOrThrow(await selectAndRun({}, 'research')).prompts);
});

test('a Ticket Kind with no Strategy fails with StrategyNotFound', async () => {
  expect(await selectAndRun({}, 'prototype')).toEqual(Result.fail(new StrategyNotFound({ kind: 'prototype' })));
  expect(await selectAndRun({ strategies: { grilling: [{ prompt: 'Grill.' }] } }, 'grilling')).toSatisfy(Result.isSuccess);
});
