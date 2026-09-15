import { type AgentProvider, claudeCode, codex, cursor, opencode, run } from '@ai-hero/sandcastle';
import { noSandbox } from '@ai-hero/sandcastle/sandboxes/no-sandbox';
import { Console, Effect, type Path } from 'effect';

import { HarnessRuntimeError } from '~/Core/Shared/Domain/Exceptions/HarnessRuntimeError';
import type { HarnessName } from '~/Core/Shared/Domain/Properties/HarnessName';
import type { Harness, HarnessRunOptions, ModelDemand, ModelGeneration, ModelTier } from '~/Core/Shared/Ports/Harness';
import { getTicketHandle } from '~/Infrastructure/Tickets/WorktreeManager/sandcastle';

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

// Runs one prompt through the Sandcastle API on the host, with no container.
// The full harness log goes to a file, not to the main output.
const sandcastleHarness = (name: HarnessName, repositoryRoot: string, path: Path.Path): Harness => ({
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
      const logging = loggingOf(path, repositoryRoot, options.label);
      if (options.cwd !== undefined) {
        const handle = getTicketHandle(options.cwd);
        if (handle === undefined) {
          return yield* new HarnessRuntimeError();
        }
        return yield* Effect.tryPromise({
          try: (signal) =>
            handle.run({
              agent: provider,
              sandbox: noSandbox(),
              prompt,
              signal,
              ...(options.completionSignal === undefined ? {} : { completionSignal: [...options.completionSignal] }),
              logging,
            }),
          catch: () => new HarnessRuntimeError(),
        });
      }
      return yield* Effect.tryPromise({
        try: (signal) =>
          run({
            agent: provider,
            sandbox: noSandbox(),
            prompt,
            signal,
            ...(options.completionSignal === undefined ? {} : { completionSignal: [...options.completionSignal] }),
            logging,
          }),
        catch: () => new HarnessRuntimeError(),
      });
    }).pipe(Effect.map((result) => ({ completionSignal: result.completionSignal }))),
});

export const registeredHarnessesOf = (repositoryRoot: string, path: Path.Path): Record<HarnessName, Harness> => ({
  Codex: sandcastleHarness('Codex', repositoryRoot, path),
  Cursor: sandcastleHarness('Cursor', repositoryRoot, path),
  Claude: sandcastleHarness('Claude', repositoryRoot, path),
  OpenCode: sandcastleHarness('OpenCode', repositoryRoot, path),
});
