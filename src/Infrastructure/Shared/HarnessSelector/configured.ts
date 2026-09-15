import { Clock, DateTime, Effect, Layer, Path } from 'effect';

import type { HarnessName } from '~/Core/Shared/Domain/Properties/HarnessName';
import { type ConfiguredHarness, EngineConfig, engineConfig } from '~/Core/Shared/Domain/EngineConfig';
import { RepositoryRoot } from '~/Core/Shared/Domain/RepositoryRoot';
import type { Harness } from '~/Core/Shared/Ports/Harness';
import { HarnessSelector } from '~/Core/Shared/Ports/HarnessSelector';

import { recurrenceCovers } from './recurrence';
import { registeredHarnessesOf } from './registered';

export const EngineConfigLive = Layer.effect(EngineConfig, engineConfig);

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

const isWeighted = (
  harnesses: readonly ConfiguredHarness[]
): harnesses is readonly (ConfiguredHarness & { readonly priority: NonNullable<ConfiguredHarness['priority']> })[] =>
  harnesses.length > 0 && harnesses.every((harness) => harness.priority !== undefined);

const buildSchedule = (harnesses: readonly ConfiguredHarness[], resolve: (name: HarnessName) => Harness): Harness[] => {
  const names = harnesses.map((harness) => harness.name);
  if (!isWeighted(harnesses)) {
    return names.map(resolve);
  }

  const weights = Object.fromEntries(harnesses.map((harness) => [harness.name, Number(harness.priority)]));

  const leader = names.reduce((a, b) => (weights[a]! >= weights[b]! ? a : b));

  if (names.some((name) => name !== leader && weights[name] === weights[leader])) {
    throw new Error('Strict leadership requires a unique highest weight');
  }

  const divisor = Object.values(weights).reduce(gcd);
  const quota = Object.fromEntries(names.map((name) => [name, weights[name]! / divisor]));
  const used = Object.fromEntries(names.map((name) => [name, 0]));
  const length = Object.values(quota).reduce((sum, count) => sum + count, 0);
  const schedule: HarnessName[] = [];

  for (let step = 1; step <= length; step++) {
    const eligible = names.filter(
      (name) => used[name]! < quota[name]! && (name === leader || used[name]! + 1 < used[leader]!)
    );

    const deficit = (name: HarnessName) => step * quota[name]! - used[name]! * length;

    const selected = eligible.reduce((best, name) => (deficit(name) > deficit(best) ? name : best));

    schedule.push(selected);
    used[selected]!++;
  }

  return schedule.map(resolve);
};

const makeRotation = (harnesses: readonly ConfiguredHarness[], resolve: (name: HarnessName) => Harness) => {
  const items = buildSchedule(harnesses, resolve);
  let next = 0;
  return {
    next: () => items[next++ % items.length] ?? items[0]!,
  };
};

export const HarnessSelectorLive = Layer.effect(
  HarnessSelector,
  Effect.gen(function* () {
    const config = yield* EngineConfig;
    const registered = registeredHarnessesOf(yield* RepositoryRoot, yield* Path.Path);
    const resolve = (name: HarnessName): Harness => registered[name];
    const fallback = makeRotation(config.harnesses, resolve);
    const islands = (config.schedule ?? []).map((island) => ({
      rrule: island.rrule,
      rotation: makeRotation(island.harnesses, resolve),
    }));
    return {
      select: Clock.currentTimeMillis.pipe(
        Effect.map((now) => {
          const at = DateTime.toDateUtc(DateTime.makeUnsafe(now));
          const active = islands.find((island) => recurrenceCovers(island.rrule, at));
          return (active?.rotation ?? fallback).next();
        })
      ),
    };
  })
);

export const ConfiguredHarnessesLive = HarnessSelectorLive.pipe(Layer.provideMerge(EngineConfigLive));
