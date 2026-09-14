import { Clock, DateTime, Effect, Layer, Path } from 'effect';

import type { AgentName } from '~/Core/Shared/Domain/Properties/AgentName';
import { type ConfiguredAgent, HarnessConfig, harnessConfig } from '~/Core/Shared/Domain/HarnessConfig';
import { RepositoryRoot } from '~/Core/Shared/Domain/RepositoryRoot';
import type { Agent } from '~/Core/Shared/Ports/Agent';
import { AgentRepository } from '~/Core/Shared/Ports/AgentRepository';

import { recurrenceCovers } from './recurrence';
import { registeredAgentsOf } from './registered';

export const HarnessConfigLive = Layer.effect(HarnessConfig, harnessConfig);

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

const isWeighted = (
  agents: readonly ConfiguredAgent[]
): agents is readonly (ConfiguredAgent & { readonly priority: NonNullable<ConfiguredAgent['priority']> })[] =>
  agents.length > 0 && agents.every((agent) => agent.priority !== undefined);

const buildSchedule = (agents: readonly ConfiguredAgent[], resolve: (name: AgentName) => Agent): Agent[] => {
  const names = agents.map((agent) => agent.name);
  if (!isWeighted(agents)) {
    return names.map(resolve);
  }

  const weights = Object.fromEntries(agents.map((agent) => [agent.name, Number(agent.priority)]));

  const leader = names.reduce((a, b) => (weights[a]! >= weights[b]! ? a : b));

  if (names.some((name) => name !== leader && weights[name] === weights[leader])) {
    throw new Error('Strict leadership requires a unique highest weight');
  }

  const divisor = Object.values(weights).reduce(gcd);
  const quota = Object.fromEntries(names.map((name) => [name, weights[name]! / divisor]));
  const used = Object.fromEntries(names.map((name) => [name, 0]));
  const length = Object.values(quota).reduce((sum, count) => sum + count, 0);
  const schedule: AgentName[] = [];

  for (let step = 1; step <= length; step++) {
    const eligible = names.filter(
      (name) => used[name]! < quota[name]! && (name === leader || used[name]! + 1 < used[leader]!)
    );

    const deficit = (name: AgentName) => step * quota[name]! - used[name]! * length;

    const selected = eligible.reduce((best, name) => (deficit(name) > deficit(best) ? name : best));

    schedule.push(selected);
    used[selected]!++;
  }

  return schedule.map(resolve);
};

const makeRotation = (agents: readonly ConfiguredAgent[], resolve: (name: AgentName) => Agent) => {
  const items = buildSchedule(agents, resolve);
  let next = 0;
  return {
    next: () => items[next++ % items.length] ?? items[0]!,
  };
};

export const AgentRepositoryLive = Layer.effect(
  AgentRepository,
  Effect.gen(function* () {
    const config = yield* HarnessConfig;
    const registered = registeredAgentsOf(yield* RepositoryRoot, yield* Path.Path);
    const resolve = (name: AgentName): Agent => registered[name];
    const fallback = makeRotation(config.agents, resolve);
    const islands = (config.schedule ?? []).map((island) => ({
      rrule: island.rrule,
      rotation: makeRotation(island.agents, resolve),
    }));
    return {
      getOne: Clock.currentTimeMillis.pipe(
        Effect.map((now) => {
          const at = DateTime.toDateUtc(DateTime.makeUnsafe(now));
          const active = islands.find((island) => recurrenceCovers(island.rrule, at));
          return (active?.rotation ?? fallback).next();
        })
      ),
    };
  })
);

export const ConfiguredAgentsLive = AgentRepositoryLive.pipe(Layer.provideMerge(HarnessConfigLive));
