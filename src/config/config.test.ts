import { DateTime, Effect } from 'effect';
import { expect, test } from 'vitest';

import {
  defaultIdleTimeout,
  defaultPollInterval,
  harnessConfig,
  harnessConfigProvider,
} from '~/Core/Shared/Domain/HarnessConfig';

import { harnessFileConfig as folderExample } from './examples/folder';
import { harnessFileConfig as linearExample } from './examples/linear';
import { harnessFileConfig as scheduleExample } from './examples/schedule';

test('folder example loads', () => {
  expect(Effect.runSync(harnessConfig.parse(harnessConfigProvider(folderExample)))).toEqual({
    agents: [{ name: 'Codex' }, { name: 'Cursor' }, { name: 'Claude' }, { name: 'OpenCode' }],
    schedule: [],
    otlpTraceUrl: 'http://127.0.0.1:4318/v1/traces',
    source: {
      _tag: 'folder',
      ticketsDir: '.agents/tickets',
    },
    idleTimeout: defaultIdleTimeout,
    pollInterval: defaultPollInterval,
  });
});

test('schedule example loads', () => {
  expect(Effect.runSync(harnessConfig.parse(harnessConfigProvider(scheduleExample)))).toEqual({
    agents: [{ name: 'Codex' }, { name: 'Cursor' }, { name: 'Claude' }, { name: 'OpenCode' }],
    schedule: [
      {
        agents: [{ name: 'Cursor' }],
        rrule: {
          freq: 'DAILY',
          dtstart: DateTime.toDateUtc(DateTime.makeUnsafe('2026-01-01T18:00:00.000Z')),
          byhour: [0, 1, 2, 3, 4, 5, 6, 7, 8, 18, 19, 20, 21, 22, 23],
          tzid: 'UTC',
        },
      },
    ],
    idleTimeout: defaultIdleTimeout,
    pollInterval: defaultPollInterval,
  });
});

test('linear example loads', () => {
  expect(Effect.runSync(harnessConfig.parse(harnessConfigProvider(linearExample)))).toEqual({
    agents: [{ name: 'Codex' }, { name: 'Cursor' }, { name: 'Claude' }, { name: 'OpenCode' }],
    schedule: [],
    source: {
      _tag: 'linear',
      teamId: 'your-team-id',
    },
    idleTimeout: defaultIdleTimeout,
    pollInterval: defaultPollInterval,
  });
});
