import * as NodeServices from '@effect/platform-node/NodeServices';
import { Effect, FileSystem, Layer, Path, PlatformError } from 'effect';
import { ChildProcessSpawner } from 'effect/unstable/process';
import { expect, test } from 'vitest';

import { RepositoryRoot } from '~/Core/Shared/Domain/RepositoryRoot';
import { RepositoryRootNotFound } from '~/Core/Tickets/Domain/Exceptions/RepositoryRootNotFound';

import { RepositoryRootLive } from './repositoryRoot';

const recordingGit = (lookups: number[], root = '/bound-root') =>
  Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, {
    ...ChildProcessSpawner.make(() => Effect.die('unused')),
    string: () => {
      lookups.push(1);
      return Effect.succeed(`${root}\n`);
    },
  });

const failingGit = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, {
  ...ChildProcessSpawner.make(() => Effect.die('unused')),
  string: () =>
    Effect.fail(
      PlatformError.systemError({
        module: 'ChildProcess',
        _tag: 'NotFound',
        method: 'spawn',
      })
    ),
});

test('a successful start binds git rev-parse --show-toplevel as the Repository Root', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* RepositoryRoot;
      expect(yield* fs.exists(path.join(root, '.git'))).toBe(true);
    }).pipe(Effect.provide(RepositoryRootLive.pipe(Layer.provideMerge(NodeServices.layer))))
  );
});

test('two readers in one run see the same Repository Root', async () => {
  const lookups: number[] = [];
  const [first, second] = await Effect.runPromise(
    Effect.all([RepositoryRoot, RepositoryRoot]).pipe(
      Effect.provide(RepositoryRootLive.pipe(Layer.provide(recordingGit(lookups))))
    )
  );
  expect(first).toBe('/bound-root');
  expect(second).toBe('/bound-root');
  expect(lookups).toHaveLength(1);
});

test('a failed lookup does not bind a Repository Root', async () => {
  const error = await Effect.runPromise(
    RepositoryRoot.pipe(Effect.provide(RepositoryRootLive.pipe(Layer.provide(failingGit))), Effect.flip)
  );
  expect(error).toBeInstanceOf(RepositoryRootNotFound);
});

test('binding the Repository Root does not change the start folder of the process', async () => {
  const startedIn = process.cwd();
  await Effect.runPromise(
    RepositoryRoot.pipe(Effect.provide(RepositoryRootLive.pipe(Layer.provide(recordingGit([])))))
  );
  expect(process.cwd()).toBe(startedIn);
});
