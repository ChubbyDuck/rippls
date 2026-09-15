import * as NodeServices from '@effect/platform-node/NodeServices';
import { Console, Effect, FileSystem, Layer, Path } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { expect, test } from 'vitest';

import { WorktreeCreationError } from '~/Core/Tickets/Domain/Exceptions/WorktreeCreationError';

import { ensureDependencies } from './ensureDependencies';

const recordingSpawner = (installs: { command: string; args: readonly string[]; cwd?: string }[]) =>
  Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, {
    ...ChildProcessSpawner.make(() => Effect.die('unused')),
    string: (command) =>
      Effect.sync(() => {
        if (ChildProcess.isStandardCommand(command)) {
          installs.push({ command: command.command, args: command.args, cwd: command.options.cwd });
        }
        return '';
      }),
  });

const failingSpawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, {
  ...ChildProcessSpawner.make(() => Effect.die('unused')),
  string: () => Effect.fail(new WorktreeCreationError() as never),
});

const capturingConsole = (messages: string[]): Console.Console =>
  Object.assign(Object.create(console), {
    log: (...args: ReadonlyArray<unknown>) => {
      messages.push(args.map(String).join(' '));
    },
  });

const run = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner>,
  spawner: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>,
  messages: string[] = []
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        Layer.mergeAll(NodeServices.layer, spawner, Layer.succeed(Console.Console, capturingConsole(messages)))
      )
    )
  );

const tempDir = FileSystem.FileSystem.pipe(
  Effect.flatMap((fs) => fs.makeTempDirectory({ prefix: 'engine-deps-' }))
);

const writeManifest = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.writeFileString(path.join(dir, 'package.json'), '{"name":"demo","private":true}');
  });

test('installs workspace dependencies when the worktree has a manifest and no node_modules', async () => {
  const installs: { command: string; args: readonly string[]; cwd?: string }[] = [];
  const messages: string[] = [];
  const services = recordingSpawner(installs);
  const dir = await run(
    Effect.gen(function* () {
      const created = yield* tempDir;
      yield* writeManifest(created);
      return created;
    }),
    services
  );

  await run(ensureDependencies(dir), services, messages);

  expect(installs).toEqual([{ command: 'corepack', args: ['pnpm', 'install'], cwd: dir }]);
  expect(messages).toEqual([
    `Dependencies are installing with corepack pnpm install at ${dir}`,
    `Dependencies are ready at ${dir}`,
  ]);
});

test('does not install when the worktree has no package manifest', async () => {
  const installs: { command: string; args: readonly string[]; cwd?: string }[] = [];
  const messages: string[] = [];
  const services = recordingSpawner(installs);
  const dir = await run(tempDir, services);

  await run(ensureDependencies(dir), services, messages);

  expect(installs).toEqual([]);
  expect(messages).toEqual([`Dependencies are skipped at ${dir} (no package.json)`]);
});

test('does not install when node_modules is already present', async () => {
  const installs: { command: string; args: readonly string[]; cwd?: string }[] = [];
  const messages: string[] = [];
  const services = recordingSpawner(installs);
  const dir = await run(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const created = yield* tempDir;
      yield* writeManifest(created);
      yield* fs.makeDirectory(path.join(created, 'node_modules'));
      return created;
    }),
    services
  );

  await run(ensureDependencies(dir), services, messages);

  expect(installs).toEqual([]);
  expect(messages).toEqual([`Dependencies are already present at ${dir}`]);
});

test('fails worktree creation when the install fails', async () => {
  const dir = await run(
    Effect.gen(function* () {
      const created = yield* tempDir;
      yield* writeManifest(created);
      return created;
    }),
    recordingSpawner([])
  );

  const failure = await run(ensureDependencies(dir).pipe(Effect.flip), failingSpawner);

  expect(failure).toBeInstanceOf(WorktreeCreationError);
});
