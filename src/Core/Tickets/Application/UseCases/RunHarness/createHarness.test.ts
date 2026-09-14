import { Effect, Random } from 'effect';
import { expect, test } from 'vitest';

import { createHarness } from './createHarness';

test('createHarness names each spawned runner from a readable harness id', () => {
  const harness = Effect.runSync(createHarness);

  expect(harness.id).toMatch(/^[a-z]+-[a-z]+-[0-9a-z]{4}$/);
  expect(harness.spawn().id).toBe(`${harness.id}:0`);
  expect(harness.spawn().id).toBe(`${harness.id}:1`);
});

test('each evaluation creates a fresh harness and runner sequence', () => {
  Effect.runSync(
    Effect.gen(function* () {
      const first = yield* createHarness;
      expect(first.spawn().id).toBe(`${first.id}:0`);
      const second = yield* createHarness;

      expect(second).not.toBe(first);
      expect(second.id).not.toBe(first.id);
      expect(second.spawn().id).toBe(`${second.id}:0`);
      expect(first.spawn().id).toBe(`${first.id}:1`);
    }).pipe(Random.withSeed('harness-lifetime'))
  );
});
