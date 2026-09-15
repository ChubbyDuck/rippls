import { Schema } from 'effect';
import { expect, test } from 'vitest';

import { EngineId } from './EngineId';
import { runnerIdFrom } from './RunnerId';

test('runnerIdFrom derives a runner id from an engine id and a unique value', () => {
  const engineId = Schema.decodeSync(EngineId)('engine-a');

  expect(runnerIdFrom(engineId, '0')).toBe('engine-a:0');
  expect(runnerIdFrom(engineId, '1')).toBe('engine-a:1');
});
