import { Data, Effect, FileSystem, Path, Schema } from 'effect';
import { parse } from 'yaml';

import { defaultEngineConfig } from '~/Core/Shared/Domain/EngineConfig';

const CONFIG_FILES = [
  'rippls.config.ts',
  'rippls.config.js',
  'rippls.config.json',
  'rippls.config.yaml',
  'rippls.config.yml',
] as const;

const JsonUnknown = Schema.fromJsonString(Schema.Unknown);

export class ConfigFileError extends Data.TaggedError('ConfigFileError')<{
  readonly path: string;
  readonly cause: unknown;
}> {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const configFromModule = (mod: Record<string, unknown>): unknown => {
  if (mod.engineFileConfig !== undefined) {
    return mod.engineFileConfig;
  }
  return mod.default;
};

// A plain object, as config files write one: no array, no Date, no class instance.
const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (!isRecord(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

// The repository config over the user config: plain objects merge key by key at
// every level; arrays and values replace. A Strategy is the array of its steps, so a
// Strategy given for a Kind replaces that Kind's Strategy whole.
export const mergeConfigs = (user: unknown, repository: unknown): unknown => {
  if (!isPlainObject(user) || !isPlainObject(repository)) {
    return repository === undefined ? user : repository;
  }
  const merged: Record<string, unknown> = { ...user };
  for (const [key, value] of Object.entries(repository)) {
    merged[key] = mergeConfigs(user[key], value);
  }
  return merged;
};

// The defaults a config file leaves out. A folder Source keeps a configured tickets
// folder, resolved against the Repository Root; without one it has none here, and
// takes the nearest queue when its Source is resolved (see `locateQueue`).
export const applyConfigDefaults = (input: unknown, root: string, path: Path.Path) => {
  const record = isRecord(input) ? input : {};
  const withHarnesses = record.harnesses === undefined ? { ...record, harnesses: defaultEngineConfig.harnesses } : record;
  const source = withHarnesses.source;
  if (!isRecord(source)) {
    return { ...withHarnesses, source: { _tag: 'folder' } };
  }
  if (source._tag === 'folder' && typeof source.ticketsDir === 'string') {
    return { ...withHarnesses, source: { ...source, ticketsDir: path.resolve(root, source.ticketsDir) } };
  }
  return withHarnesses;
};

const asRecord = (raw: unknown, path: string) =>
  isRecord(raw)
    ? Effect.succeed(raw)
    : Effect.fail(new ConfigFileError({ path, cause: 'must contain a configuration object' }));

const parseFile = (file: string, name: (typeof CONFIG_FILES)[number], text: string) => {
  const parsed = name.endsWith('.json')
    ? Schema.decodeEffect(JsonUnknown)(text).pipe(
        Effect.mapError((cause) => new ConfigFileError({ path: file, cause }))
      )
    : Effect.try({
        try: () => parse(text) as unknown,
        catch: (cause) => new ConfigFileError({ path: file, cause }),
      });
  return parsed.pipe(Effect.flatMap((raw) => asRecord(raw, file)));
};

const importFile = (file: string, path: Path.Path) =>
  path.toFileUrl(file).pipe(
    Effect.mapError((cause) => new ConfigFileError({ path: file, cause })),
    Effect.flatMap((url) =>
      Effect.tryPromise({
        try: () => import(url.href) as Promise<Record<string, unknown>>,
        catch: (cause) => new ConfigFileError({ path: file, cause }),
      })
    ),
    Effect.map(configFromModule),
    Effect.flatMap((raw) =>
      raw === undefined || isRecord(raw)
        ? Effect.succeed(raw)
        : Effect.fail(new ConfigFileError({ path: file, cause: 'must export a configuration object' }))
    )
  );

// The config file in a folder, the first of `CONFIG_FILES` that exists, or nothing.
const readConfigIn = Effect.fn('config.read')(function* (folder: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const name of CONFIG_FILES) {
    const file = path.join(folder, name);
    if (!(yield* fs.exists(file))) {
      continue;
    }
    return name.endsWith('.ts') || name.endsWith('.js')
      ? yield* importFile(file, path)
      : yield* parseFile(file, name, yield* fs.readFileString(file));
  }
  return undefined;
});

// The user's config folder: `$XDG_CONFIG_HOME/rippls`, or `~/.config/rippls`.
export const userConfigDir = (env: { readonly XDG_CONFIG_HOME?: string | undefined }, home: string, path: Path.Path) =>
  env.XDG_CONFIG_HOME === undefined || env.XDG_CONFIG_HOME === ''
    ? path.join(home, '.config', 'rippls')
    : path.join(env.XDG_CONFIG_HOME, 'rippls');

// The repository config at the Repository Root over the user config in its folder.
// Neither file is required.
export const loadEngineFileConfig = Effect.fn('config.load')(function* (root: string, userDir?: string) {
  const path = yield* Path.Path;
  const user = userDir === undefined ? undefined : yield* readConfigIn(userDir);
  const repository = yield* readConfigIn(root);
  return applyConfigDefaults(mergeConfigs(user, repository), root, path);
});
