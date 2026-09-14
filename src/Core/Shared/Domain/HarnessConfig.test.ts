import { ConfigProvider, DateTime, Duration, Effect } from 'effect';
import { expect, test } from 'vitest';

import {
  defaultHarnessConfig,
  defaultIdleTimeout,
  defaultPollInterval,
  harnessConfig,
  harnessConfigProvider,
  resolveTicketSource,
} from './HarnessConfig';

const defaultTimings = {
  idleTimeout: defaultIdleTimeout,
  pollInterval: defaultPollInterval,
};

const load = (entries: Record<string, unknown>) =>
  harnessConfig.parse(ConfigProvider.fromUnknown(entries));

test('harnessConfig uses the default agent list when agents are absent', () => {
  expect(Effect.runSync(load({}))).toEqual(defaultHarnessConfig);
  expect(defaultHarnessConfig.agents).toEqual([
    { name: 'Codex' },
    { name: 'Cursor' },
    { name: 'Claude' },
    { name: 'OpenCode' },
  ]);
});

test('harnessConfig reads agent names without priorities', () => {
  expect(Effect.runSync(load({ agents: [{ name: 'Codex' }, { name: 'Cursor' }] }))).toEqual({
    agents: [{ name: 'Codex' }, { name: 'Cursor' }],
    schedule: [],
    ...defaultTimings,
  });
});

test('harnessConfig rejects an unknown agent name', () => {
  expect(Effect.runSync(load({ agents: [{ name: 'coder' }] }).pipe(Effect.flip)).cause.message).toBe(
    'Expected "Codex" | "Cursor" | "Claude" | "OpenCode"\n  at ["agents"][0]["name"]'
  );
});

test('harnessConfig rejects a mix of agents with and without priority', () => {
  expect(
    Effect.runSync(
      load({
        agents: [{ name: 'Codex', priority: 2 }, { name: 'Cursor' }],
      }).pipe(Effect.flip)
    ).cause.message
  ).toBe('Either every agent has a priority or none do\n  at ["agents"]');
});

test('harnessConfig reads the configured agent names and priorities', () => {
  expect(
    Effect.runSync(
      load({
        agents: [
          { name: 'Codex', priority: 40 },
          { name: 'Cursor', priority: 30 },
        ],
      })
    )
  ).toEqual({
    agents: [
      { name: 'Codex', priority: 40 },
      { name: 'Cursor', priority: 30 },
    ],
    schedule: [],
    ...defaultTimings,
  });
});

test('harnessConfig rejects an empty agent list', () => {
  expect(Effect.runSync(load({ agents: [] }).pipe(Effect.flip)).cause.message).toBe(
    'Missing key\n  at ["agents"][0]'
  );
});

test('harnessConfig rejects agents without a unique highest priority', () => {
  expect(
    Effect.runSync(
      load({
        agents: [
          { name: 'Codex', priority: 2 },
          { name: 'Cursor', priority: 2 },
        ],
      }).pipe(Effect.flip)
    ).cause.message
  ).toBe('Strict leadership requires a unique highest weight\n  at ["agents"]');
});

test('harnessConfig expands a daily from/to rule into an rrule', () => {
  const dtstart = DateTime.toDateUtc(DateTime.makeUnsafe('2026-01-01T18:00:00.000Z'));

  expect(
    Effect.runSync(
      load({
        agents: [{ name: 'Codex' }],
        schedule: [
          {
            agents: [{ name: 'Cursor' }],
            rule: {
              freq: 'DAILY',
              from: '18:00',
              to: '09:00',
              tzid: 'Europe/Sofia',
            },
          },
        ],
      })
    )
  ).toEqual({
    agents: [{ name: 'Codex' }],
    schedule: [
      {
        agents: [{ name: 'Cursor' }],
        rrule: {
          freq: 'DAILY',
          dtstart,
          byhour: [0, 1, 2, 3, 4, 5, 6, 7, 8, 18, 19, 20, 21, 22, 23],
          tzid: 'Europe/Sofia',
        },
      },
    ],
    ...defaultTimings,
  });
});

test('harnessConfig expands a same-day from/to rule into an rrule', () => {
  const dtstart = DateTime.toDateUtc(DateTime.makeUnsafe('2026-01-01T14:00:00.000Z'));

  expect(
    Effect.runSync(
      load({
        agents: [{ name: 'Codex' }],
        schedule: [
          {
            agents: [{ name: 'Cursor' }],
            rule: {
              freq: 'DAILY',
              from: '14:00',
              to: '19:00',
              tzid: 'Europe/Sofia',
            },
          },
        ],
      })
    )
  ).toEqual({
    agents: [{ name: 'Codex' }],
    schedule: [
      {
        agents: [{ name: 'Cursor' }],
        rrule: {
          freq: 'DAILY',
          dtstart,
          byhour: [14, 15, 16, 17, 18],
          tzid: 'Europe/Sofia',
        },
      },
    ],
    ...defaultTimings,
  });
});

test('harnessConfig reads scheduled agent islands with an rrule', () => {
  const dtstart = DateTime.toDateUtc(DateTime.makeUnsafe('2026-01-01T00:00:00.000Z'));

  expect(
    Effect.runSync(
      load({
        agents: [{ name: 'Codex' }],
        schedule: [
          {
            agents: [{ name: 'Cursor' }],
            rrule: {
              freq: 'HOURLY',
              dtstart: '2026-01-01T00:00:00.000Z',
              byhour: [10],
            },
          },
        ],
      })
    )
  ).toEqual({
    agents: [{ name: 'Codex' }],
    schedule: [
      {
        agents: [{ name: 'Cursor' }],
        rrule: {
          freq: 'HOURLY',
          dtstart,
          byhour: [10],
        },
      },
    ],
    ...defaultTimings,
  });
});

test('harnessConfig reads scheduled rrule dates from Date instances', () => {
  const dtstart = DateTime.toDateUtc(DateTime.makeUnsafe('2026-01-01T00:00:00.000Z'));

  expect(
    Effect.runSync(
      harnessConfig.parse(
        harnessConfigProvider({
          agents: [{ name: 'Codex' }],
          schedule: [
            {
              agents: [{ name: 'Cursor' }],
              rrule: {
                freq: 'HOURLY',
                dtstart,
                byhour: [10],
              },
            },
          ],
        })
      )
    )
  ).toEqual({
    agents: [{ name: 'Codex' }],
    schedule: [
      {
        agents: [{ name: 'Cursor' }],
        rrule: {
          freq: 'HOURLY',
          dtstart,
          byhour: [10],
        },
      },
    ],
    ...defaultTimings,
  });
});

test('harnessConfig reads an optional otlpTraceUrl', () => {
  expect(
    Effect.runSync(
      load({
        agents: [{ name: 'Codex' }],
        otlpTraceUrl: 'http://127.0.0.1:27686/v1/traces',
      })
    )
  ).toEqual({
    agents: [{ name: 'Codex' }],
    schedule: [],
    otlpTraceUrl: 'http://127.0.0.1:27686/v1/traces',
    ...defaultTimings,
  });
});

test('harnessConfig reads idleTimeout and pollInterval', () => {
  expect(
    Effect.runSync(
      load({
        agents: [{ name: 'Codex' }],
        idleTimeout: '2 minutes',
        pollInterval: '30 seconds',
      })
    )
  ).toEqual({
    agents: [{ name: 'Codex' }],
    schedule: [],
    idleTimeout: Duration.minutes(2),
    pollInterval: Duration.seconds(30),
  });
});

test('harnessConfig rejects a scheduled island without an rrule', () => {
  expect(
    Effect.runSync(
      load({
        agents: [{ name: 'Codex' }],
        schedule: [{ agents: [{ name: 'Cursor' }] }],
      }).pipe(Effect.flip)
    ).cause.message
  ).toBe('Missing key\n  at ["schedule"][0]["rule"]\nMissing key\n  at ["schedule"][0]["rrule"]');
});

test('harnessConfig rejects scheduled agents without a unique highest priority', () => {
  expect(
    Effect.runSync(
      load({
        agents: [{ name: 'Codex' }],
        schedule: [
          {
            agents: [
              { name: 'Codex', priority: 2 },
              { name: 'Cursor', priority: 2 },
            ],
            rrule: { freq: 'DAILY', dtstart: '2026-01-01T00:00:00.000Z' },
          },
        ],
      }).pipe(Effect.flip)
    ).cause.message
  ).toBe(
    'Strict leadership requires a unique highest weight\n  at ["schedule"][0]["agents"]\nStrict leadership requires a unique highest weight\n  at ["schedule"][0]["agents"]'
  );
});

test('harnessConfig reads a folder source', () => {
  expect(
    Effect.runSync(
      load({
        agents: [{ name: 'Codex' }],
        source: { _tag: 'folder', ticketsDir: '/tmp/tickets' },
      })
    )
  ).toEqual({
    agents: [{ name: 'Codex' }],
    schedule: [],
    source: { _tag: 'folder', ticketsDir: '/tmp/tickets' },
    ...defaultTimings,
  });
});

test('harnessConfig reads a linear source', () => {
  expect(
    Effect.runSync(
      load({
        agents: [{ name: 'Codex' }],
        source: { _tag: 'linear', teamId: 'team-1', apiKeyEnv: 'LINEAR_API_KEY' },
      })
    )
  ).toEqual({
    agents: [{ name: 'Codex' }],
    schedule: [],
    source: { _tag: 'linear', teamId: 'team-1', apiKeyEnv: 'LINEAR_API_KEY' },
    ...defaultTimings,
  });
});

test('harnessConfig reads a linear source without apiKeyEnv', () => {
  expect(
    Effect.runSync(
      load({
        agents: [{ name: 'Codex' }],
        source: { _tag: 'linear', teamId: 'team-1' },
      })
    )
  ).toEqual({
    agents: [{ name: 'Codex' }],
    schedule: [],
    source: { _tag: 'linear', teamId: 'team-1' },
    ...defaultTimings,
  });
});

test('harnessConfig rejects a folder source without ticketsDir', () => {
  expect(
    Effect.runSync(
      load({
        agents: [{ name: 'Codex' }],
        source: { _tag: 'folder' },
      }).pipe(Effect.flip)
    ).cause.message
  ).toBe('Missing key\n  at ["source"]["ticketsDir"]\nExpected "linear"\n  at ["source"]["_tag"]');
});

test('harnessConfig rejects a linear source without teamId', () => {
  expect(
    Effect.runSync(
      load({
        agents: [{ name: 'Codex' }],
        source: { _tag: 'linear' },
      }).pipe(Effect.flip)
    ).cause.message
  ).toBe('Expected "folder"\n  at ["source"]["_tag"]\nMissing key\n  at ["source"]["teamId"]');
});

test('resolveTicketSource uses the configured source when the CLI omits it', () => {
  const config = Effect.runSync(
    load({
      agents: [{ name: 'Codex' }],
      source: { _tag: 'folder', ticketsDir: '/tmp/tickets' },
    })
  );
  expect(Effect.runSync(resolveTicketSource(config.source))).toEqual({
    _tag: 'folder',
    ticketsDir: '/tmp/tickets',
  });
});

test('resolveTicketSource lets the CLI source override the configured source', () => {
  const config = Effect.runSync(
    load({
      agents: [{ name: 'Codex' }],
      source: { _tag: 'linear', teamId: 'team-1' },
    })
  );
  expect(Effect.runSync(resolveTicketSource(config.source, 'linear'))).toEqual({
    _tag: 'linear',
    teamId: 'team-1',
  });
});

test('resolveTicketSource fails when the CLI selects an incomplete source', () => {
  const config = Effect.runSync(
    load({
      agents: [{ name: 'Codex' }],
      source: { _tag: 'folder', ticketsDir: '/tmp/tickets' },
    })
  );
  expect(Effect.runSync(resolveTicketSource(config.source, 'linear').pipe(Effect.flip)).cause.message).toBe(
    'Expected "folder"\n  at ["source"]["_tag"]\nMissing key\n  at ["source"]["teamId"]'
  );
});

test('resolveTicketSource fails when the source is missing', () => {
  expect(Effect.runSync(resolveTicketSource(undefined).pipe(Effect.flip)).cause.message).toBe(
    'Expected object\n  at ["source"]\nExpected object\n  at ["source"]'
  );
});
