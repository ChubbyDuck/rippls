import { Effect, Random, Schema } from 'effect';

import { Harness } from '~/Core/Shared/Domain/Entities/Harness';
import { HarnessId } from '~/Core/Shared/Domain/Properties/HarnessId';

const adjectives = [
  'amber',
  'brisk',
  'calm',
  'crisp',
  'dusty',
  'eager',
  'faint',
  'gold',
  'hardy',
  'ivory',
  'jolly',
  'keen',
  'lucky',
  'merry',
  'noble',
  'open',
  'proud',
  'quiet',
  'rapid',
  'sunny',
  'tidy',
  'vivid',
  'warm',
  'young',
  'coral',
  'frost',
  'honey',
  'jade',
  'lime',
  'moss',
  'navy',
  'opal',
] as const;

const nouns = [
  'oak',
  'fox',
  'wren',
  'pike',
  'brook',
  'ridge',
  'cove',
  'dune',
  'glen',
  'hawk',
  'ibis',
  'jay',
  'kite',
  'lark',
  'moth',
  'newt',
  'otter',
  'perch',
  'quail',
  'raven',
  'seal',
  'tern',
  'vole',
  'asp',
  'bass',
  'crane',
  'dove',
  'elk',
  'finch',
  'goose',
  'heron',
  'ibex',
] as const;

const suffixRange = 36 ** 4;

export const createHarness = Effect.all({
  adjective: Random.choice(adjectives),
  noun: Random.choice(nouns),
  n: Random.nextIntBetween(0, suffixRange, { halfOpen: true }),
}).pipe(
  Effect.map(({ adjective, noun, n }) => {
    const id = Schema.decodeSync(HarnessId)(`${adjective}-${noun}-${n.toString(36).padStart(4, '0')}`);
    return new Harness(id);
  })
);
