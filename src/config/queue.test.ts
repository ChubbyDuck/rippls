import * as NodeServices from '@effect/platform-node/NodeServices';
import { Effect, FileSystem, Path } from 'effect';
import { expect, test } from 'vitest';

import { TicketsDir } from '~/Core/Shared/Domain/EngineConfig';
import { RepositoryRoot } from '~/Core/Shared/Domain/RepositoryRoot';

import { locateQueue, nearestQueue, queueLine } from './queue';

// A temporary folder by its real path, with the folders given below it.
const tree = (...folders: readonly string[]) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const base = yield* fs.realPath(yield* fs.makeTempDirectory({ prefix: 'rippls-queue-' }));
      yield* Effect.forEach(folders, (folder) => fs.makeDirectory(path.join(base, folder), { recursive: true }));
      return base;
    }).pipe(Effect.provide(NodeServices.layer))
  );

const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)));

const fail = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) => run(Effect.flip(effect));

test('from a nested app folder, the nearest queue is the app queue, not the root queue', async () => {
  const root = await tree('.agents/tickets', 'apps/web/.agents/tickets', 'apps/web/src/pages');

  expect(await run(nearestQueue(`${root}/apps/web/src/pages`, root))).toBe(`${root}/apps/web/.agents/tickets`);
});

test('from a folder of an app without a queue, the nearest queue is the root queue', async () => {
  const root = await tree('.agents/tickets', 'apps/api/src');

  expect(await run(nearestQueue(`${root}/apps/api/src`, root))).toBe(`${root}/.agents/tickets`);
});

test('from the Repository Root, the queue is the root queue', async () => {
  const root = await tree('.agents/tickets', 'apps/web/.agents/tickets');

  expect(await run(nearestQueue(root, root))).toBe(`${root}/.agents/tickets`);
});

test('a start folder reached through a symbolic link finds the queue by its real path', async () => {
  const base = await tree('repo/.agents/tickets', 'repo/apps/web/.agents/tickets', 'repo/apps/web/src', 'links');
  await run(
    FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.symlink(`${base}/repo/apps/web`, `${base}/links/web`)))
  );

  expect(await run(nearestQueue(`${base}/links/web/src`, `${base}/repo`))).toBe(
    `${base}/repo/apps/web/.agents/tickets`
  );
});

test('a Repository Root reached through a symbolic link compares by its real path', async () => {
  const base = await tree('repo/.agents/tickets', 'repo/apps/web');
  await run(FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.symlink(`${base}/repo`, `${base}/linked-repo`))));

  expect(await run(nearestQueue(`${base}/repo/apps/web`, `${base}/linked-repo`))).toBe(
    `${base}/repo/.agents/tickets`
  );
});

test('with no queue up to the Repository Root, the lookup fails naming rippls init and the config key', async () => {
  const root = await tree('apps/web/src');

  const error = await fail(nearestQueue(`${root}/apps/web/src`, root));

  expect(error._tag).toBe('QueueNotFound');
  expect(error.message).toContain('rippls init');
  expect(error.message).toContain('source.ticketsDir');
  expect(error.message).toContain(`${root}/apps/web/src`);
});

test('the lookup never goes above the Repository Root', async () => {
  const base = await tree('.agents/tickets', 'repo/apps/web');

  expect((await fail(nearestQueue(`${base}/repo/apps/web`, `${base}/repo`)))._tag).toBe('QueueNotFound');
});

test('a start folder outside the Repository Root finds no queue', async () => {
  const base = await tree('repo/.agents/tickets', 'elsewhere/.agents/tickets');

  expect((await fail(nearestQueue(`${base}/elsewhere`, `${base}/repo`)))._tag).toBe('QueueNotFound');
});

test('a configured tickets folder wins over the lookup', async () => {
  const root = await tree('.agents/tickets', 'apps/web/.agents/tickets', 'queue');
  const ticketsDir = TicketsDir.make(`${root}/queue`);

  expect(
    await run(
      locateQueue({ _tag: 'folder', ticketsDir }, `${root}/apps/web`).pipe(Effect.provideService(RepositoryRoot, root))
    )
  ).toEqual({ _tag: 'folder', ticketsDir });
});

test('a folder Source without a tickets folder takes the nearest queue and keeps its other settings', async () => {
  const root = await tree('apps/web/.agents/tickets');

  expect(
    await run(
      locateQueue({ _tag: 'folder', defaultHitl: 'no' }, `${root}/apps/web`).pipe(
        Effect.provideService(RepositoryRoot, root)
      )
    )
  ).toEqual({ _tag: 'folder', defaultHitl: 'no', ticketsDir: `${root}/apps/web/.agents/tickets` });
});

test('a Linear Source has no queue to look up', async () => {
  const root = await tree();

  expect(
    await run(
      locateQueue({ _tag: 'linear', teamId: 'team-1' }, root).pipe(Effect.provideService(RepositoryRoot, root))
    )
  ).toEqual({ _tag: 'linear', teamId: 'team-1' });
});

test('the start line names the queue the run uses', () => {
  expect(queueLine({ _tag: 'folder', ticketsDir: TicketsDir.make('/repo/apps/web/.agents/tickets') })).toBe(
    'Queue: /repo/apps/web/.agents/tickets'
  );
  expect(queueLine({ _tag: 'linear', teamId: 'team-1' })).toBe('Queue: the Linear team team-1');
});
