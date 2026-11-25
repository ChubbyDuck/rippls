import { type AgentProvider, claudeCode, codex, cursor, opencode, run } from '@ai-hero/sandcastle';
import { noSandbox } from '@ai-hero/sandcastle/sandboxes/no-sandbox';
import { Console, Effect, type FileSystem, type Path, type PlatformError } from 'effect';

import { HarnessRuntimeError } from '~/Core/Shared/Domain/Exceptions/HarnessRuntimeError';
import type { HarnessName } from '~/Core/Shared/Domain/Properties/HarnessName';
import type { Harness, HarnessRunOptions, ModelDemand, ModelGeneration, ModelTier } from '~/Core/Shared/Ports/Harness';

type CatalogEntry = {
  readonly id: string;
  readonly tier: ModelTier;
  readonly fast: boolean;
  readonly generation: ModelGeneration;
};

const catalogOf = <const Entries extends readonly [CatalogEntry, ...CatalogEntry[]]>(
  entries: Entries,
  defaultId: Entries[number]['id']
) => ({ entries, default: defaultId });

// Each harness fills the shared sections it has. Empty sections are simply absent.
const catalogs = {
  Claude: catalogOf(
    [
      { id: 'claude-opus-4-8', tier: 'high', fast: false, generation: 'current' },
      { id: 'claude-sonnet-4-6', tier: 'low', fast: true, generation: 'current' },
    ],
    'claude-opus-4-8'
  ),
  Codex: catalogOf(
    [
      { id: 'gpt-5.6-luna', tier: 'low', fast: false, generation: 'current' },
      { id: 'gpt-5.6-sol-high', tier: 'high', fast: false, generation: 'current' },
    ],
    'gpt-5.6-luna'
  ),
  Cursor: catalogOf(
    [
      { id: 'cursor-grok-4.6-high', tier: 'high', fast: false, generation: 'current' },
      { id: 'cursor-grok-4.6-high-fast', tier: 'high', fast: true, generation: 'current' },
      { id: 'composer-2.5-fast', tier: 'low', fast: true, generation: 'previous' },
    ],
    'cursor-grok-4.6-high'
  ),
  OpenCode: catalogOf(
    [
      { id: 'anthropic/claude-opus-4-8', tier: 'high', fast: false, generation: 'current' },
      { id: 'anthropic/claude-sonnet-4-6', tier: 'mid', fast: true, generation: 'current' },
    ],
    'anthropic/claude-opus-4-8'
  ),
} satisfies Record<HarnessName, { entries: readonly CatalogEntry[]; default: string }>;

const factories: Record<HarnessName, (model: string) => AgentProvider> = {
  Claude: claudeCode,
  Codex: codex,
  Cursor: cursor,
  OpenCode: opencode,
};

const providersOf = (name: HarnessName): Record<string, AgentProvider> =>
  Object.fromEntries(catalogs[name].entries.map((entry) => [entry.id, factories[name](entry.id)]));

const providers: Record<HarnessName, Record<string, AgentProvider>> = {
  Claude: providersOf('Claude'),
  Codex: providersOf('Codex'),
  Cursor: providersOf('Cursor'),
  OpenCode: providersOf('OpenCode'),
};

const matchesDemand = (entry: CatalogEntry, demand: ModelDemand) =>
  (demand.tier === undefined || entry.tier === demand.tier) &&
  (demand.fast === undefined || entry.fast === demand.fast) &&
  (demand.generation === undefined || entry.generation === demand.generation);

const demandLabelOf = (demand: ModelDemand): string => {
  const parts: string[] = [];
  if (demand.tier !== undefined) {
    parts.push(`${demand.tier}-tier`);
  }
  if (demand.fast !== undefined) {
    parts.push(demand.fast ? 'fast' : 'not fast');
  }
  if (demand.generation !== undefined) {
    parts.push(`${demand.generation}-generation`);
  }
  return parts.join(', ');
};

const modelIdOf = (
  name: HarnessName,
  demand: ModelDemand | undefined
): { readonly id: string; readonly fellBack: boolean } => {
  const catalog = catalogs[name];
  if (demand === undefined) {
    return { id: catalog.default, fellBack: false };
  }
  const matched = catalog.entries.find((entry) => matchesDemand(entry, demand));
  return matched === undefined ? { id: catalog.default, fellBack: true } : { id: matched.id, fellBack: false };
};

const loggingOf = (path: Path.Path, repositoryRoot: string, label: string) => ({
  type: 'file' as const,
  path: path.join(repositoryRoot, '.sandcastle', 'logs', `${label}.log`),
  verbose: true,
});

const isNotFound = (error: PlatformError.PlatformError) => error.reason._tag === 'NotFound';

// The logs folder keeps itself out of Git with an ignore file of its own, so that a
// log never makes the Workspace dirty: in place, the logs are inside the Repository
// Root that the clean check reads. An ignore file already there is kept. A folder
// that cannot be written is left to the run, which reports its own failure.
const ignoreLogs = (fs: FileSystem.FileSystem, path: Path.Path, repositoryRoot: string) => {
  const logs = path.join(repositoryRoot, '.sandcastle', 'logs');
  const ignoreFile = path.join(logs, '.gitignore');
  return fs.exists(ignoreFile).pipe(
    Effect.flatMap((exists) =>
      exists
        ? Effect.void
        : fs.makeDirectory(logs, { recursive: true }).pipe(Effect.andThen(fs.writeFileString(ignoreFile, '*\n')))
    ),
    Effect.ignore
  );
};

// The keys of the Repository Root's `.sandcastle/.env`. Sandcastle reads that file
// from the run's working directory, and in a Ticket Worktree it does not exist (Git
// ignores it), so Rippls passes its keys as the run's environment. A missing file
// has no keys.
const escapes: Record<string, string> = { n: '\n', r: '\r', t: '\t', '\\': '\\' };

// The keys of a `.env` file with a non-empty value, read by the rules of Sandcastle's
// own reader (EnvResolver), so that the Agent in a Ticket Worktree gets the values
// it gets in the Repository Root. A key with an empty value is left to the shell.
const envFileKeysOf = (text: string): Record<string, string> => {
  const keys: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    const equals = trimmed.indexOf('=');
    if (trimmed === '' || trimmed.startsWith('#') || equals === -1) {
      continue;
    }
    const key = trimmed.slice(0, equals).trim();
    let value = trimmed.slice(equals + 1).trim();
    const quote = value.length >= 2 && value[0] === value.at(-1) ? value[0] : undefined;
    if (quote === '"' || quote === "'") {
      value = value.slice(1, -1);
    }
    if (quote === '"') {
      value = value.replace(/\\([nrt\\])/g, (_, escaped: string) => escapes[escaped] ?? escaped);
    }
    if (value === '') {
      delete keys[key];
    } else {
      keys[key] = value;
    }
  }
  return keys;
};

const rootEnvOf = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  repositoryRoot: string
): Effect.Effect<Record<string, string>, HarnessRuntimeError> =>
  fs.readFileString(path.join(repositoryRoot, '.sandcastle', '.env')).pipe(
    Effect.map(envFileKeysOf),
    Effect.catchIf(isNotFound, () => Effect.succeed({})),
    Effect.mapError(() => new HarnessRuntimeError())
  );

// Runs one prompt through the Sandcastle API on the host, with no container. With
// a working directory, the Agent works in that directory as it is: a Ticket
// Worktree, whether it was created in this run or reused from disk. The full
// harness log goes to a file, not to the main output.
const sandcastleHarness = (
  name: HarnessName,
  repositoryRoot: string,
  path: Path.Path,
  fs: FileSystem.FileSystem
): Harness => ({
  name,
  model: catalogs[name].default,
  run: (prompt, options: HarnessRunOptions) =>
    Effect.gen(function* () {
      const selected = modelIdOf(name, options.model);
      if (selected.fellBack && options.model !== undefined) {
        yield* Console.log(
          `${options.label} is using default model '${selected.id}' because no ${demandLabelOf(options.model)} model matched`
        );
      }
      const provider = providers[name][selected.id]!;
      const env = yield* rootEnvOf(fs, path, repositoryRoot);
      yield* ignoreLogs(fs, path, repositoryRoot);
      return yield* Effect.tryPromise({
        try: (signal) =>
          run({
            agent: provider,
            sandbox: noSandbox({ env }),
            prompt,
            signal,
            ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
            ...(options.completionSignal === undefined ? {} : { completionSignal: [...options.completionSignal] }),
            logging: loggingOf(path, repositoryRoot, options.label),
          }),
        catch: () => new HarnessRuntimeError(),
      });
    }).pipe(Effect.map((result) => ({ completionSignal: result.completionSignal }))),
});

export const registeredHarnessesOf = (
  repositoryRoot: string,
  path: Path.Path,
  fs: FileSystem.FileSystem
): Record<HarnessName, Harness> => ({
  Codex: sandcastleHarness('Codex', repositoryRoot, path, fs),
  Cursor: sandcastleHarness('Cursor', repositoryRoot, path, fs),
  Claude: sandcastleHarness('Claude', repositoryRoot, path, fs),
  OpenCode: sandcastleHarness('OpenCode', repositoryRoot, path, fs),
});
