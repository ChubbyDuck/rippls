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

import { loadEngineFileConfig, userConfigDir } from './load';

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

test('defaults to a folder source with no tickets folder when no config file exists', async () => {
  const root = await withTempRoot(() => Effect.void);

  expect(await load(root)).toEqual({
    harnesses: [{ name: 'Codex' }, { name: 'Cursor' }, { name: 'Claude' }, { name: 'OpenCode' }],
    source: { _tag: 'folder' },
  });

  expect(Effect.runSync(engineConfig.parse(engineConfigProvider(await load(root))))).toEqual({
    harnesses: [{ name: 'Codex' }, { name: 'Cursor' }, { name: 'Claude' }, { name: 'OpenCode' }],
    schedule: [],
    source: { _tag: 'folder' },
    idleTimeout: defaultIdleTimeout,
    pollInterval: defaultPollInterval,
    defaultKind: 'implementation',
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
    source: { _tag: 'folder' },
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

test('leaves ticketsDir out when a folder source omits it', async () => {
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
    source: { _tag: 'folder' },
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

// A user config folder and a Repository Root, each with the files given.
const withUserAndRoot = (user: Record<string, string>, repository: Record<string, string>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const userDir = yield* fs.makeTempDirectory({ prefix: 'rippls-user-config-' });
      const root = yield* fs.makeTempDirectory({ prefix: 'rippls-config-' });
      yield* Effect.forEach(Object.entries(user), ([name, text]) => fs.writeFileString(path.join(userDir, name), text));
      yield* Effect.forEach(Object.entries(repository), ([name, text]) => fs.writeFileString(path.join(root, name), text));
      return { userDir, root };
    }).pipe(Effect.provide(NodeServices.layer))
  );

const loadWithUser = ({ root, userDir }: { readonly root: string; readonly userDir: string }) =>
  Effect.runPromise(loadEngineFileConfig(root, userDir).pipe(Effect.provide(NodeServices.layer)));

test('the repository config wins over the user config: objects merge key by key, arrays and Strategies replace', async () => {
  const dirs = await withUserAndRoot(
    {
      'rippls.config.yaml': [
        'harnesses:',
        '  - name: Claude',
        '  - name: Cursor',
        'check:',
        '  command: pnpm test',
        '  fixAttempts: 2',
        '  projects:',
        '    web: pnpm web:test',
        'strategies:',
        '  implementation:',
        '    - prompt: /implement {{id}}',
        '    - prompt: /review {{id}}',
        '      verdict: true',
        '  research:',
        '    - prompt: /research {{id}}',
        '',
      ].join('\n'),
    },
    {
      'rippls.config.json': jsonString({
        harnesses: [{ name: 'Codex' }],
        check: { fixAttempts: 0, projects: { api: 'pnpm api:test' } },
        strategies: { implementation: [{ prompt: 'Implement {{id}}' }] },
      }),
    }
  );

  expect(await loadWithUser(dirs)).toEqual({
    harnesses: [{ name: 'Codex' }],
    check: {
      command: 'pnpm test',
      fixAttempts: 0,
      projects: { web: 'pnpm web:test', api: 'pnpm api:test' },
    },
    strategies: {
      implementation: [{ prompt: 'Implement {{id}}' }],
      research: [{ prompt: '/research {{id}}' }],
    },
    source: { _tag: 'folder' },
  });
});

test('a user config alone loads, with its relative ticketsDir resolved against the Repository Root', async () => {
  const dirs = await withUserAndRoot(
    { 'rippls.config.json': jsonString({ harnesses: [{ name: 'Claude' }], source: { _tag: 'folder', ticketsDir: 'queue' } }) },
    {}
  );

  expect(await loadWithUser(dirs)).toEqual({
    harnesses: [{ name: 'Claude' }],
    source: { _tag: 'folder', ticketsDir: path.resolve(dirs.root, 'queue') },
  });
});

test('a repository config alone loads when the user config folder has no file', async () => {
  const dirs = await withUserAndRoot({}, { 'rippls.config.yaml': 'harnesses:\n  - name: Cursor\n' });

  expect(await loadWithUser(dirs)).toEqual({ harnesses: [{ name: 'Cursor' }], source: { _tag: 'folder' } });
});

test('neither file is required, and a missing user config folder is no error', async () => {
  const root = await withTempRoot(() => Effect.void);

  expect(await loadWithUser({ root, userDir: path.join(root, 'no-such-folder') })).toEqual({
    harnesses: [{ name: 'Codex' }, { name: 'Cursor' }, { name: 'Claude' }, { name: 'OpenCode' }],
    source: { _tag: 'folder' },
  });
});

test('the user config folder is under XDG_CONFIG_HOME, or ~/.config without it', () => {
  expect(userConfigDir({ XDG_CONFIG_HOME: '/xdg' }, '/home/me', path)).toBe('/xdg/rippls');
  expect(userConfigDir({}, '/home/me', path)).toBe('/home/me/.config/rippls');
  expect(userConfigDir({ XDG_CONFIG_HOME: '' }, '/home/me', path)).toBe('/home/me/.config/rippls');
});
