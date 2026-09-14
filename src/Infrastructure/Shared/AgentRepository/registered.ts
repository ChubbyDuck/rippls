import { type AgentProvider, claudeCode, codex, cursor, opencode, run } from '@ai-hero/sandcastle';
import { noSandbox } from '@ai-hero/sandcastle/sandboxes/no-sandbox';
import { Console, Effect, type Path } from 'effect';

import { AgentRuntimeError } from '~/Core/Shared/Domain/Exceptions/AgentRuntimeError';
import type { AgentName } from '~/Core/Shared/Domain/Properties/AgentName';
import type { Agent, AgentRunOptions, ModelDemand, ModelGeneration, ModelTier } from '~/Core/Shared/Ports/Agent';
import { getTicketHandle } from '~/Infrastructure/Tickets/WorktreeRepository/sandcastle';

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

// Each agent fills the shared sections it has. Empty sections are simply absent.
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
} satisfies Record<AgentName, { entries: readonly CatalogEntry[]; default: string }>;

const factories: Record<AgentName, (model: string) => AgentProvider> = {
  Claude: claudeCode,
  Codex: codex,
  Cursor: cursor,
  OpenCode: opencode,
};

const providersOf = (name: AgentName): Record<string, AgentProvider> =>
  Object.fromEntries(catalogs[name].entries.map((entry) => [entry.id, factories[name](entry.id)]));

const providers: Record<AgentName, Record<string, AgentProvider>> = {
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
  name: AgentName,
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
// The full agent log goes to a file, not to the main output.
const sandcastleAgent = (name: AgentName, repositoryRoot: string, path: Path.Path): Agent => ({
  name,
  model: catalogs[name].default,
  run: (prompt, options: AgentRunOptions) =>
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
          return yield* new AgentRuntimeError();
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
          catch: () => new AgentRuntimeError(),
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
        catch: () => new AgentRuntimeError(),
      });
    }).pipe(Effect.map((result) => ({ completionSignal: result.completionSignal }))),
});

export const registeredAgentsOf = (repositoryRoot: string, path: Path.Path): Record<AgentName, Agent> => ({
  Codex: sandcastleAgent('Codex', repositoryRoot, path),
  Cursor: sandcastleAgent('Cursor', repositoryRoot, path),
  Claude: sandcastleAgent('Claude', repositoryRoot, path),
  OpenCode: sandcastleAgent('OpenCode', repositoryRoot, path),
});
