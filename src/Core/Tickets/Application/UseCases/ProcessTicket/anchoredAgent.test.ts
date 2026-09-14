import { Effect } from 'effect';
import { expect, test } from 'vitest';

import type { Agent, AgentRunOptions } from '~/Core/Shared/Ports/Agent';

import { anchoredAgent } from './anchoredAgent';

test('every run on the wrapped agent carries the bound working directory', async () => {
  const calls: AgentRunOptions[] = [];
  const inner: Agent = {
    name: 'inner',
    model: 'inner-model',
    run: (_prompt, options) =>
      Effect.sync(() => {
        calls.push(options);
        return { completionSignal: undefined };
      }),
  };
  const agent = anchoredAgent(inner, '/repo');

  await Effect.runPromise(agent.run('first', { label: 'a' }));
  await Effect.runPromise(agent.run('second', { label: 'b', cwd: '/other' }));

  expect(calls.map((call) => call.cwd)).toEqual(['/repo', '/repo']);
});
