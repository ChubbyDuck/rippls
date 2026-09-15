import { run } from '@ai-hero/sandcastle';
import * as NodePath from '@effect/platform-node/NodePath';
import { Console, Effect, Layer, Path } from 'effect';
import { beforeEach, expect, test, vi } from 'vitest';

import { HarnessRuntimeError } from '~/Core/Shared/Domain/Exceptions/HarnessRuntimeError';
import {
  clearTicketHandles,
  registerTicketHandle,
} from '~/Infrastructure/Tickets/WorktreeManager/sandcastle';

import { registeredHarnessesOf } from './registered';

const repositoryRoot = '/repo';
const path = Effect.runSync(Path.Path.pipe(Effect.provide(NodePath.layer)));
const { Claude } = registeredHarnessesOf(repositoryRoot, path);

vi.mock('@ai-hero/sandcastle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ai-hero/sandcastle')>();
  return {
    ...actual,
    run: vi.fn(),
  };
});

const runMock = vi.mocked(run);

runMock.mockResolvedValue({
  completionSignal: undefined,
  iterations: [],
  stdout: '',
  commits: [],
  branch: 'main',
});

const handleRun = vi.fn();

beforeEach(() => {
  runMock.mockClear();
  handleRun.mockClear();
  clearTicketHandles();
  handleRun.mockResolvedValue({
    completionSignal: undefined,
    iterations: [],
    stdout: '',
    commits: [],
    branch: 'ticket-11',
  });
});

test('a run with a working directory uses the ticket worktree handle', async () => {
  registerTicketHandle('/tmp/worktree', { run: handleRun } as never);

  await Effect.runPromise(Claude.run('do the work', { label: 'ticket-11', cwd: '/tmp/worktree' }));

  expect(handleRun).toHaveBeenCalledTimes(1);
  expect(runMock).not.toHaveBeenCalled();
  expect(handleRun.mock.calls[0]?.[0]).toMatchObject({
    prompt: 'do the work',
  });
  expect(handleRun.mock.calls[0]?.[0]).not.toHaveProperty('cwd');
  expect(handleRun.mock.calls[0]?.[0]).not.toHaveProperty('branchStrategy');
  expect(handleRun.mock.calls[0]?.[0].logging).toEqual({
    type: 'file',
    path: '/repo/.sandcastle/logs/ticket-11.log',
    verbose: true,
  });
});

test('a run with a working directory and no ticket worktree fails', async () => {
  const failure = await Effect.runPromise(
    Claude.run('do the work', { label: 'ticket-11', cwd: '/tmp/missing' }).pipe(Effect.flip)
  );

  expect(failure).toBeInstanceOf(HarnessRuntimeError);
  expect(runMock).not.toHaveBeenCalled();
  expect(handleRun).not.toHaveBeenCalled();
});

test('a run without a working directory uses the top-level runner', async () => {
  await Effect.runPromise(Claude.run('do the work', { label: 'ticket-11' }));

  expect(runMock.mock.calls[0]?.[0]).not.toHaveProperty('cwd');
  expect(runMock.mock.calls[0]?.[0]).not.toHaveProperty('branchStrategy');
  expect(handleRun).not.toHaveBeenCalled();
});

test('a run records a log path under the Repository Root', async () => {
  await Effect.runPromise(Claude.run('do the work', { label: 'ticket-11' }));

  expect(runMock.mock.calls[0]?.[0].logging).toEqual({
    type: 'file',
    path: '/repo/.sandcastle/logs/ticket-11.log',
    verbose: true,
  });
});

const printCommandOf = (call: unknown) => {
  const { agent: harness } = call as {
    agent: {
      buildPrintCommand: (options: { prompt: string; dangerouslySkipPermissions: boolean }) => {
        command: string;
      };
    };
  };
  return harness.buildPrintCommand({ prompt: 'x', dangerouslySkipPermissions: false }).command;
};

const capturingConsoleOf = (messages: string[]) =>
  Object.assign(Object.create(console), {
    log: (...args: ReadonlyArray<unknown>) => {
      messages.push(args.map(String).join(' '));
    },
  }) as Console.Console;

test('a run without a model demand uses the default', async () => {
  const messages: string[] = [];

  await Effect.runPromise(
    Claude.run('do the work', { label: 'ticket-11' }).pipe(
      Effect.provide(Layer.succeed(Console.Console, capturingConsoleOf(messages)))
    )
  );

  expect(printCommandOf(runMock.mock.calls[0]?.[0])).toContain("--model 'claude-opus-4-8'");
  expect(messages).toEqual([]);
});

test('a run with a model demand uses the first matching model', async () => {
  await Effect.runPromise(
    Claude.run('do the work', { label: 'ticket-11', model: { tier: 'low', fast: true, generation: 'current' } })
  );

  expect(printCommandOf(runMock.mock.calls[0]?.[0])).toContain("--model 'claude-sonnet-4-6'");
});

test('the same demand resolves against the harness that is running', async () => {
  const { Cursor } = registeredHarnessesOf(repositoryRoot, path);

  await Effect.runPromise(Cursor.run('do the work', { label: 'ticket-11', model: { tier: 'high', fast: true } }));

  expect(printCommandOf(runMock.mock.calls[0]?.[0])).toContain("--model 'cursor-grok-4.6-high-fast'");
});

test('a run with several matches uses the first listed model', async () => {
  const { Cursor } = registeredHarnessesOf(repositoryRoot, path);

  await Effect.runPromise(Cursor.run('do the work', { label: 'ticket-11', model: { tier: 'high' } }));

  expect(printCommandOf(runMock.mock.calls[0]?.[0])).toContain("--model 'cursor-grok-4.6-high'");
});

test('a run with a demand no model satisfies uses the default and says so', async () => {
  const messages: string[] = [];

  await Effect.runPromise(
    Claude.run('do the work', { label: 'ticket-11', model: { generation: 'previous' } }).pipe(
      Effect.provide(Layer.succeed(Console.Console, capturingConsoleOf(messages)))
    )
  );

  expect(printCommandOf(runMock.mock.calls[0]?.[0])).toContain("--model 'claude-opus-4-8'");
  expect(messages).toEqual([
    "ticket-11 is using default model 'claude-opus-4-8' because no previous-generation model matched",
  ]);
});
