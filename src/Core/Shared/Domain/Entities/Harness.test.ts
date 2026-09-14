import { Schema } from 'effect';
import { expect, test } from 'vitest';

import { HarnessId } from '../Properties/HarnessId';
import { Harness } from './Harness';
import { Runner } from './Runner';

test('Harness gives its runners distinct identities without sharing its sequence with another harness', () => {
  const first = new Harness(Schema.decodeSync(HarnessId)('first'));
  const second = new Harness(Schema.decodeSync(HarnessId)('second'));
  const runner = first.spawn();

  expect(runner).toBeInstanceOf(Runner);
  expect(runner.id).toBe('first:0');
  expect(second.spawn().id).toBe('second:0');
  expect(first.spawn().id).toBe('first:1');
  expect(runner.id).toBe('first:0');
});
