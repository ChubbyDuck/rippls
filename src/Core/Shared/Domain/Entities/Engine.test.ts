import { Schema } from 'effect';
import { expect, test } from 'vitest';

import { EngineId } from '../Properties/EngineId';
import { Engine } from './Engine';
import { Runner } from './Runner';

test('Engine gives its runners distinct identities without sharing its sequence with another engine', () => {
  const first = new Engine(Schema.decodeSync(EngineId)('first'));
  const second = new Engine(Schema.decodeSync(EngineId)('second'));
  const runner = first.spawn();

  expect(runner).toBeInstanceOf(Runner);
  expect(runner.id).toBe('first:0');
  expect(second.spawn().id).toBe('second:0');
  expect(first.spawn().id).toBe('first:1');
  expect(runner.id).toBe('first:0');
});
