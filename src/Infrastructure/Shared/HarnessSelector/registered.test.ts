import { run } from '@ai-hero/sandcastle';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { Console, Effect, FileSystem, Layer, Path, type PlatformError } from 'effect';
import { beforeEach, expect, test, vi } from 'vitest';

import { registeredHarnessesOf } from './registered';

const repositoryRoot = '/repo';
const path = Effect.runSync(Path.Path.pipe(Effect.provide(NodePath.layer)));
const fs = Effect.runSync(FileSystem.FileSystem.pipe(Effect.provide(NodeFileSystem.layer)));
const { Claude } = registeredHarnessesOf(repositoryRoot, path, fs);

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
  const { Cursor } = registeredHarnessesOf(repositoryRoot, path, fs);

  await Effect.runPromise(Cursor.run('do the work', { label: 'ticket-11', model: { tier: 'high', fast: true } }));

  expect(printCommandOf(runMock.mock.calls[0]?.[0])).toContain("--model 'cursor-grok-4.6-high-fast'");
});

test('a run with several matches uses the first listed model', async () => {
  const { Cursor } = registeredHarnessesOf(repositoryRoot, path, fs);

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

const sandboxEnvOf = (call: unknown) => (call as { sandbox: { env: Record<string, string> } }).sandbox.env;

// Runs a Claude run in a Ticket Worktree of a new Repository Root, which `prepare` may fill.
const runInTemporaryRoot = (prepare: (root: string) => Effect.Effect<void, PlatformError.PlatformError>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* fs.makeTempDirectoryScoped({ prefix: 'rippls-root-env-' });
        yield* prepare(root);
        const { Claude: harness } = registeredHarnessesOf(root, path, fs);
        yield* harness.run('do the work', { label: 'ticket-11', cwd: path.join(root, 'worktree') });
      })
    )
  );

test("a run in a Ticket Worktree gets the keys of the Repository Root's .sandcastle/.env", async () => {
  await runInTemporaryRoot((root) =>
    fs.makeDirectory(path.join(root, '.sandcastle')).pipe(
      Effect.andThen(
        fs.writeFileString(
          path.join(root, '.sandcastle', '.env'),
          '# keys for the Agent\nRIPPLS_ROOT_ONLY_KEY=from-the-root\n'
        )
      )
    )
  );

  expect(sandboxEnvOf(runMock.mock.calls[0]?.[0])).toEqual({ RIPPLS_ROOT_ONLY_KEY: 'from-the-root' });
});

test('a run with no .sandcastle/.env in the Repository Root still runs, with no extra keys', async () => {
  await runInTemporaryRoot(() => Effect.void);

  expect(runMock).toHaveBeenCalledTimes(1);
  expect(sandboxEnvOf(runMock.mock.calls[0]?.[0])).toEqual({});
});
