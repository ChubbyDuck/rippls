import { Schema } from 'effect';
import { expect, test } from 'vitest';

import { HarnessId } from './HarnessId';
import { runnerIdFrom } from './RunnerId';

test('runnerIdFrom derives a runner id from a harness id and a unique value', () => {
  const harnessId = Schema.decodeSync(HarnessId)('harness-a');

  expect(runnerIdFrom(harnessId, '0')).toBe('harness-a:0');
  expect(runnerIdFrom(harnessId, '1')).toBe('harness-a:1');
});
