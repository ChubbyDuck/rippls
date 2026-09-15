import * as NodePath from '@effect/platform-node/NodePath';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { Effect, FileSystem, Path, Schema } from 'effect';
import { expect, test } from 'vitest';

import {
  defaultIdleTimeout,
  defaultPollInterval,
  engineConfig,
  engineConfigProvider,
} from '~/Core/Shared/Domain/EngineConfig';

import { loadEngineFileConfig } from './load';

const path = Effect.runSync(Path.Path.pipe(Effect.provide(NodePath.layer)));
const jsonUnknown = Schema.fromJsonString(Schema.Unknown);
const jsonString = Schema.encodeSync(jsonUnknown);

const load = (root: string) =>
  Effect.runPromise(loadEngineFileConfig(root).pipe(Effect.provide(NodeServices.layer)));

const withTempRoot = <E>(
  write: (root: string) => Effect.Effect<void, E, FileSystem.FileSystem | Path.Path>
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectory({ prefix: 'rippls-config-' });
      yield* write(root);
      return root;
    }).pipe(Effect.provide(NodeServices.layer))
  );

test('defaults to a folder source under the repository root when no config file exists', async () => {
  const root = await withTempRoot(() => Effect.void);

  expect(await load(root)).toEqual({
    harnesses: [{ name: 'Codex' }, { name: 'Cursor' }, { name: 'Claude' }, { name: 'OpenCode' }],
    source: { _tag: 'folder', ticketsDir: path.resolve(root, '.agents/tickets') },
  });

  expect(Effect.runSync(engineConfig.parse(engineConfigProvider(await load(root))))).toEqual({
    harnesses: [{ name: 'Codex' }, { name: 'Cursor' }, { name: 'Claude' }, { name: 'OpenCode' }],
    schedule: [],
    source: { _tag: 'folder', ticketsDir: path.resolve(root, '.agents/tickets') },
    idleTimeout: defaultIdleTimeout,
    pollInterval: defaultPollInterval,
  });
});

test('reads rippls.config.json and resolves a relative ticketsDir', async () => {
  const root = await withTempRoot((dir) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.writeFileString(
        path.join(dir, 'rippls.config.json'),
        jsonString({
          harnesses: [{ name: 'Cursor' }],
          source: { _tag: 'folder', ticketsDir: '.agents/tickets' },
        })
      );
    })
  );

  expect(await load(root)).toEqual({
    harnesses: [{ name: 'Cursor' }],
    source: { _tag: 'folder', ticketsDir: path.resolve(root, '.agents/tickets') },
  });
});

test('loads engineFileConfig and its harnesses from a JavaScript configuration module', async () => {
  const root = await withTempRoot((dir) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.writeFileString(
        path.join(dir, 'rippls.config.js'),
        "export const engineFileConfig = { harnesses: [{ name: 'Cursor' }] };\n"
      );
    })
  );

  expect(Effect.runSync(engineConfig.parse(engineConfigProvider(await load(root))))).toMatchObject({
    harnesses: [{ name: 'Cursor' }],
    source: { _tag: 'folder', ticketsDir: path.resolve(root, '.agents/tickets') },
  });
});

test('keeps an absolute ticketsDir', async () => {
  const root = await withTempRoot((dir) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.writeFileString(
        path.join(dir, 'rippls.config.json'),
        jsonString({
          harnesses: [{ name: 'Codex' }],
          source: { _tag: 'folder', ticketsDir: '/tmp/tickets' },
        })
      );
    })
  );

  expect(await load(root)).toEqual({
    harnesses: [{ name: 'Codex' }],
    source: { _tag: 'folder', ticketsDir: '/tmp/tickets' },
  });
});

test('fills ticketsDir when a folder source omits it', async () => {
  const root = await withTempRoot((dir) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.writeFileString(
        path.join(dir, 'rippls.config.json'),
        jsonString({
          harnesses: [{ name: 'Claude' }],
          source: { _tag: 'folder' },
        })
      );
    })
  );

  expect(await load(root)).toEqual({
    harnesses: [{ name: 'Claude' }],
    source: { _tag: 'folder', ticketsDir: path.resolve(root, '.agents/tickets') },
  });
});

test('does not invent a folder source when Linear is configured', async () => {
  const root = await withTempRoot((dir) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.writeFileString(
        path.join(dir, 'rippls.config.yaml'),
        'harnesses:\n  - name: Cursor\nsource:\n  _tag: linear\n  teamId: your-team-id\n'
      );
    })
  );

  expect(await load(root)).toEqual({
    harnesses: [{ name: 'Cursor' }],
    source: { _tag: 'linear', teamId: 'your-team-id' },
  });
});

test('prefers rippls.config.json over yaml', async () => {
  const root = await withTempRoot((dir) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.writeFileString(path.join(dir, 'rippls.config.json'), jsonString({ harnesses: [{ name: 'Codex' }] }));
      yield* fs.writeFileString(path.join(dir, 'rippls.config.yaml'), 'harnesses:\n  - name: Cursor\n');
    })
  );

  expect(await load(root)).toMatchObject({ harnesses: [{ name: 'Codex' }] });
});
