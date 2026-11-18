import { run } from '@ai-hero/sandcastle';
import * as NodePath from '@effect/platform-node/NodePath';
import { Console, Effect, Layer, Path } from 'effect';
import { beforeEach, expect, test, vi } from 'vitest';

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

beforeEach(() => {
  runMock.mockClear();
});

test('a run with a working directory runs in that directory on its current branch', async () => {
  await Effect.runPromise(Claude.run('do the work', { label: 'ticket-11', cwd: '/tmp/worktree' }));

  expect(runMock).toHaveBeenCalledTimes(1);
  expect(runMock.mock.calls[0]?.[0]).toMatchObject({ prompt: 'do the work', cwd: '/tmp/worktree' });
  expect(runMock.mock.calls[0]?.[0]).not.toHaveProperty('branchStrategy');
  expect(runMock.mock.calls[0]?.[0].logging).toEqual({
    type: 'file',
    path: '/repo/.sandcastle/logs/ticket-11.log',
    verbose: true,
  });
});

test('a run without a working directory runs in the current directory', async () => {
  await Effect.runPromise(Claude.run('do the work', { label: 'ticket-11' }));

  expect(runMock.mock.calls[0]?.[0]).not.toHaveProperty('cwd');
  expect(runMock.mock.calls[0]?.[0]).not.toHaveProperty('branchStrategy');
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
