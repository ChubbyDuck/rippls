import { Effect } from 'effect';
import { expect, test } from 'vitest';

import {
  defaultIdleTimeout,
  defaultPollInterval,
  harnessConfig,
  harnessConfigProvider,
} from '~/Core/Shared/Domain/HarnessConfig';

import { harnessFileConfig } from './config';

test('harnessFileConfig loads Cursor', () => {
  expect(Effect.runSync(harnessConfig.parse(harnessConfigProvider(harnessFileConfig)))).toEqual({
    agents: [{ name: 'Cursor' }],
    schedule: [],
    otlpTraceUrl: 'http://127.0.0.1:27686/v1/traces',
    source: {
      _tag: 'folder',
      ticketsDir: '/Users/chubbyduck/_Projects/pet/rippls/.agents/tickets',
    },
    idleTimeout: defaultIdleTimeout,
    pollInterval: defaultPollInterval,
  });
});
