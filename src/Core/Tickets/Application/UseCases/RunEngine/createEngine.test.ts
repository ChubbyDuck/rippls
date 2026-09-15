import { Effect, Random } from 'effect';
import { expect, test } from 'vitest';

import { createEngine } from './createEngine';

test('createEngine names each spawned runner from a readable engine id', () => {
  const engine = Effect.runSync(createEngine);

  expect(engine.id).toMatch(/^[a-z]+-[a-z]+-[0-9a-z]{4}$/);
  expect(engine.spawn().id).toBe(`${engine.id}:0`);
  expect(engine.spawn().id).toBe(`${engine.id}:1`);
});

test('each evaluation creates a fresh engine and runner sequence', () => {
  Effect.runSync(
    Effect.gen(function* () {
      const first = yield* createEngine;
      expect(first.spawn().id).toBe(`${first.id}:0`);
      const second = yield* createEngine;

      expect(second).not.toBe(first);
      expect(second.id).not.toBe(first.id);
      expect(second.spawn().id).toBe(`${second.id}:0`);
      expect(first.spawn().id).toBe(`${first.id}:1`);
    }).pipe(Random.withSeed('engine-lifetime'))
  );
});
