import { Effect } from 'effect';
import { expect, test } from 'vitest';

import type { Harness, HarnessRunOptions } from '~/Core/Shared/Ports/Harness';

import { harnessInWorktree } from './harnessInWorktree';

test('every run on the wrapped harness carries the bound working directory', async () => {
  const calls: HarnessRunOptions[] = [];
  const inner: Harness = {
    name: 'inner',
    model: 'inner-model',
    run: (_prompt, options) =>
      Effect.sync(() => {
        calls.push(options);
        return { completionSignal: undefined };
      }),
  };
  const harness = harnessInWorktree(inner, '/repo');

  await Effect.runPromise(harness.run('first', { label: 'a' }));
  await Effect.runPromise(harness.run('second', { label: 'b', cwd: '/other' }));

  expect(calls.map((call) => call.cwd)).toEqual(['/repo', '/repo']);
});
