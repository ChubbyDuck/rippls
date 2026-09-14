import { Data, Effect, FileSystem, Path, Schema } from 'effect';
import { parse } from 'yaml';

import { defaultHarnessConfig } from '~/Core/Shared/Domain/HarnessConfig';

const DEFAULT_TICKETS_DIR = '.agents/tickets';

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
  if (mod.harnessFileConfig !== undefined) {
    return mod.harnessFileConfig;
  }
  return mod.default;
};

const defaultFolderSource = (path: Path.Path, root: string, ticketsDir = DEFAULT_TICKETS_DIR) => ({
  _tag: 'folder' as const,
  ticketsDir: path.resolve(root, ticketsDir),
});

export const applyConfigDefaults = (input: unknown, root: string, path: Path.Path) => {
  const record = isRecord(input) ? input : {};
  const withAgents = record.agents === undefined ? { ...record, agents: defaultHarnessConfig.agents } : record;
  const source = withAgents.source;
  if (!isRecord(source)) {
    return { ...withAgents, source: defaultFolderSource(path, root) };
  }
  if (source._tag === 'folder') {
    const ticketsDir = typeof source.ticketsDir === 'string' ? source.ticketsDir : DEFAULT_TICKETS_DIR;
    return { ...withAgents, source: { ...source, ticketsDir: path.resolve(root, ticketsDir) } };
  }
  return withAgents;
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

export const loadHarnessFileConfig = Effect.fn('config.load')(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const name of CONFIG_FILES) {
    const file = path.join(root, name);
    if (!(yield* fs.exists(file))) {
      continue;
    }
    const raw =
      name.endsWith('.ts') || name.endsWith('.js')
        ? yield* importFile(file, path)
        : yield* parseFile(file, name, yield* fs.readFileString(file));
    return applyConfigDefaults(raw, root, path);
  }
  return applyConfigDefaults({}, root, path);
});
