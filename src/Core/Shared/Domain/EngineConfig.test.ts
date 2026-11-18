import { ConfigProvider, DateTime, Duration, Effect, Schema } from 'effect';
import { expect, test } from 'vitest';

import { Project } from '~/Core/Tickets/Domain/Entities/Ticket/properties/Project';

import {
  checkCommandOf,
  checkConfig,
  commitConfig,
  defaultCheckConfig,
  defaultCommitConfig,
  defaultCommitPrompt,
  defaultEngineConfig,
  defaultFixPrompt,
  defaultIdleTimeout,
  defaultPollInterval,
  defaultStrategies,
  engineConfig,
  engineConfigProvider,
  resolveTicketSource,
  strategiesConfig,
} from './EngineConfig';

const defaultValues = {
  idleTimeout: defaultIdleTimeout,
  pollInterval: defaultPollInterval,
  defaultKind: 'implementation',
};

const load = (entries: Record<string, unknown>) =>
  engineConfig.parse(ConfigProvider.fromUnknown(entries));

test('engineConfig uses the default harness list when harnesses are absent', () => {
  expect(Effect.runSync(load({}))).toEqual(defaultEngineConfig);
  expect(defaultEngineConfig.harnesses).toEqual([
    { name: 'Codex' },
    { name: 'Cursor' },
    { name: 'Claude' },
    { name: 'OpenCode' },
  ]);
});

test('engineConfig reads harness names without priorities', () => {
  expect(Effect.runSync(load({ harnesses: [{ name: 'Codex' }, { name: 'Cursor' }] }))).toEqual({
    harnesses: [{ name: 'Codex' }, { name: 'Cursor' }],
    schedule: [],
    ...defaultValues,
  });
});

test('engineConfig rejects an unknown harness name', () => {
  expect(Effect.runSync(load({ harnesses: [{ name: 'coder' }] }).pipe(Effect.flip)).cause.message).toBe(
    'Expected "Codex" | "Cursor" | "Claude" | "OpenCode"\n  at ["harnesses"][0]["name"]'
  );
});

test('engineConfig rejects a mix of harnesses with and without priority', () => {
  expect(
    Effect.runSync(
      load({
        harnesses: [{ name: 'Codex', priority: 2 }, { name: 'Cursor' }],
      }).pipe(Effect.flip)
    ).cause.message
  ).toBe('Either every harness has a priority or none do\n  at ["harnesses"]');
});

test('engineConfig reads the configured harness names and priorities', () => {
  expect(
    Effect.runSync(
      load({
        harnesses: [
          { name: 'Codex', priority: 40 },
          { name: 'Cursor', priority: 30 },
        ],
      })
    )
  ).toEqual({
    harnesses: [
      { name: 'Codex', priority: 40 },
      { name: 'Cursor', priority: 30 },
    ],
    schedule: [],
    ...defaultValues,
  });
});

test('engineConfig rejects an empty harness list', () => {
  expect(Effect.runSync(load({ harnesses: [] }).pipe(Effect.flip)).cause.message).toBe(
    'Missing key\n  at ["harnesses"][0]'
  );
});

test('engineConfig rejects harnesses without a unique highest priority', () => {
  expect(
    Effect.runSync(
      load({
        harnesses: [
          { name: 'Codex', priority: 2 },
          { name: 'Cursor', priority: 2 },
        ],
      }).pipe(Effect.flip)
    ).cause.message
  ).toBe('Strict leadership requires a unique highest weight\n  at ["harnesses"]');
});

test('engineConfig expands a daily from/to rule into an rrule', () => {
  const dtstart = DateTime.toDateUtc(DateTime.makeUnsafe('2026-01-01T18:00:00.000Z'));

  expect(
    Effect.runSync(
      load({
        harnesses: [{ name: 'Codex' }],
        schedule: [
          {
            harnesses: [{ name: 'Cursor' }],
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
    harnesses: [{ name: 'Codex' }],
    schedule: [
      {
        harnesses: [{ name: 'Cursor' }],
        rrule: {
          freq: 'DAILY',
          dtstart,
          byhour: [0, 1, 2, 3, 4, 5, 6, 7, 8, 18, 19, 20, 21, 22, 23],
          tzid: 'Europe/Sofia',
        },
      },
    ],
    ...defaultValues,
  });
});

test('engineConfig expands a same-day from/to rule into an rrule', () => {
  const dtstart = DateTime.toDateUtc(DateTime.makeUnsafe('2026-01-01T14:00:00.000Z'));

  expect(
    Effect.runSync(
      load({
        harnesses: [{ name: 'Codex' }],
        schedule: [
          {
            harnesses: [{ name: 'Cursor' }],
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
    harnesses: [{ name: 'Codex' }],
    schedule: [
      {
        harnesses: [{ name: 'Cursor' }],
        rrule: {
          freq: 'DAILY',
          dtstart,
          byhour: [14, 15, 16, 17, 18],
          tzid: 'Europe/Sofia',
        },
      },
    ],
    ...defaultValues,
  });
});

test('engineConfig reads scheduled harness islands with an rrule', () => {
  const dtstart = DateTime.toDateUtc(DateTime.makeUnsafe('2026-01-01T00:00:00.000Z'));

  expect(
    Effect.runSync(
      load({
        harnesses: [{ name: 'Codex' }],
        schedule: [
          {
            harnesses: [{ name: 'Cursor' }],
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
    harnesses: [{ name: 'Codex' }],
    schedule: [
      {
        harnesses: [{ name: 'Cursor' }],
        rrule: {
          freq: 'HOURLY',
          dtstart,
          byhour: [10],
        },
      },
    ],
    ...defaultValues,
  });
});

test('engineConfig reads scheduled rrule dates from Date instances', () => {
  const dtstart = DateTime.toDateUtc(DateTime.makeUnsafe('2026-01-01T00:00:00.000Z'));

  expect(
    Effect.runSync(
      engineConfig.parse(
        engineConfigProvider({
          harnesses: [{ name: 'Codex' }],
          schedule: [
            {
              harnesses: [{ name: 'Cursor' }],
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
    harnesses: [{ name: 'Codex' }],
    schedule: [
      {
        harnesses: [{ name: 'Cursor' }],
        rrule: {
          freq: 'HOURLY',
          dtstart,
          byhour: [10],
        },
      },
    ],
    ...defaultValues,
  });
});

test('engineConfig reads an optional otlpTraceUrl', () => {
  expect(
    Effect.runSync(
      load({
        harnesses: [{ name: 'Codex' }],
        otlpTraceUrl: 'http://127.0.0.1:27686/v1/traces',
      })
    )
  ).toEqual({
    harnesses: [{ name: 'Codex' }],
    schedule: [],
    otlpTraceUrl: 'http://127.0.0.1:27686/v1/traces',
    ...defaultValues,
  });
});

test('engineConfig reads idleTimeout and pollInterval', () => {
  expect(
    Effect.runSync(
      load({
        harnesses: [{ name: 'Codex' }],
        idleTimeout: '2 minutes',
        pollInterval: '30 seconds',
      })
    )
  ).toEqual({
    harnesses: [{ name: 'Codex' }],
    schedule: [],
    idleTimeout: Duration.minutes(2),
    pollInterval: Duration.seconds(30),
    defaultKind: 'implementation',
  });
});

test('engineConfig rejects a scheduled island without an rrule', () => {
  expect(
    Effect.runSync(
      load({
        harnesses: [{ name: 'Codex' }],
        schedule: [{ harnesses: [{ name: 'Cursor' }] }],
      }).pipe(Effect.flip)
    ).cause.message
  ).toBe('Missing key\n  at ["schedule"][0]["rule"]\nMissing key\n  at ["schedule"][0]["rrule"]');
});

test('engineConfig rejects scheduled harnesses without a unique highest priority', () => {
  expect(
    Effect.runSync(
      load({
        harnesses: [{ name: 'Codex' }],
        schedule: [
          {
            harnesses: [
              { name: 'Codex', priority: 2 },
              { name: 'Cursor', priority: 2 },
            ],
            rrule: { freq: 'DAILY', dtstart: '2026-01-01T00:00:00.000Z' },
          },
        ],
      }).pipe(Effect.flip)
    ).cause.message
  ).toBe(
    'Strict leadership requires a unique highest weight\n  at ["schedule"][0]["harnesses"]\nStrict leadership requires a unique highest weight\n  at ["schedule"][0]["harnesses"]'
  );
});

test('engineConfig reads a folder source', () => {
  expect(
    Effect.runSync(
      load({
        harnesses: [{ name: 'Codex' }],
        source: { _tag: 'folder', ticketsDir: '/tmp/tickets' },
      })
    )
  ).toEqual({
    harnesses: [{ name: 'Codex' }],
    schedule: [],
    source: { _tag: 'folder', ticketsDir: '/tmp/tickets' },
    ...defaultValues,
  });
});

test('engineConfig reads a linear source', () => {
  expect(
    Effect.runSync(
      load({
        harnesses: [{ name: 'Codex' }],
        source: { _tag: 'linear', teamId: 'team-1', apiKeyEnv: 'LINEAR_API_KEY' },
      })
    )
  ).toEqual({
    harnesses: [{ name: 'Codex' }],
    schedule: [],
    source: { _tag: 'linear', teamId: 'team-1', apiKeyEnv: 'LINEAR_API_KEY' },
    ...defaultValues,
  });
});

test('engineConfig reads a linear source without apiKeyEnv', () => {
  expect(
    Effect.runSync(
      load({
        harnesses: [{ name: 'Codex' }],
        source: { _tag: 'linear', teamId: 'team-1' },
      })
    )
  ).toEqual({
    harnesses: [{ name: 'Codex' }],
    schedule: [],
    source: { _tag: 'linear', teamId: 'team-1' },
    ...defaultValues,
  });
});

test('engineConfig reads a default Ticket Kind, which is implementation unless set', () => {
  expect(Effect.runSync(load({})).defaultKind).toBe('implementation');
  expect(Effect.runSync(load({ harnesses: [{ name: 'Codex' }] })).defaultKind).toBe('implementation');
  expect(Effect.runSync(load({ harnesses: [{ name: 'Codex' }], defaultKind: 'research' })).defaultKind).toBe(
    'research'
  );
});

test('engineConfig rejects a default Ticket Kind that is not a Ticket Kind', () => {
  expect(Effect.runSync(load({ harnesses: [{ name: 'Codex' }], defaultKind: 'chore' }).pipe(Effect.flip))).toBeDefined();
});

test('engineConfig reads the HITL fallback of a folder source', () => {
  expect(
    Effect.runSync(
      load({
        harnesses: [{ name: 'Codex' }],
        source: { _tag: 'folder', ticketsDir: '/tmp/tickets', defaultHitl: 'no' },
      })
    ).source
  ).toEqual({ _tag: 'folder', ticketsDir: '/tmp/tickets', defaultHitl: 'no' });
});

test('engineConfig rejects a HITL fallback that is not yes or no', () => {
  expect(
    Effect.runSync(
      load({
        harnesses: [{ name: 'Codex' }],
        source: { _tag: 'folder', ticketsDir: '/tmp/tickets', defaultHitl: 'maybe' },
      }).pipe(Effect.flip)
    )
  ).toBeDefined();
});

test('engineConfig rejects a folder source without ticketsDir', () => {
  expect(
    Effect.runSync(
      load({
        harnesses: [{ name: 'Codex' }],
        source: { _tag: 'folder' },
      }).pipe(Effect.flip)
    ).cause.message
  ).toBe('Missing key\n  at ["source"]["ticketsDir"]\nExpected "linear"\n  at ["source"]["_tag"]');
});

test('engineConfig rejects a linear source without teamId', () => {
  expect(
    Effect.runSync(
      load({
        harnesses: [{ name: 'Codex' }],
        source: { _tag: 'linear' },
      }).pipe(Effect.flip)
    ).cause.message
  ).toBe('Expected "folder"\n  at ["source"]["_tag"]\nMissing key\n  at ["source"]["teamId"]');
});

test('resolveTicketSource uses the configured source when the CLI omits it', () => {
  const config = Effect.runSync(
    load({
      harnesses: [{ name: 'Codex' }],
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
      harnesses: [{ name: 'Codex' }],
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
      harnesses: [{ name: 'Codex' }],
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

const loadCheck = (entries: Record<string, unknown>) => checkConfig.parse(engineConfigProvider(entries));

test('checkConfig has no command, a ten-minute time limit, one fix attempt, and a prose fix prompt unless set', () => {
  expect(Effect.runSync(loadCheck({}))).toEqual(defaultCheckConfig);
  expect(Effect.runSync(loadCheck({ check: {} }))).toEqual(defaultCheckConfig);
  expect(defaultCheckConfig).toEqual({
    projects: {},
    timeLimit: Duration.minutes(10),
    fixAttempts: 1,
    fixPrompt: defaultFixPrompt,
  });
  expect(defaultFixPrompt).not.toMatch(/\//);
});

test('checkConfig reads the command, the overrides per Project, the time limit, the attempts, and the fix prompt', () => {
  expect(
    Effect.runSync(
      loadCheck({
        check: {
          command: 'pnpm typecheck && pnpm lint && pnpm test',
          projects: { web: 'pnpm --filter web check', api: 'pnpm --filter api check' },
          timeLimit: '15 minutes',
          fixAttempts: 3,
          fixPrompt: 'Run /fix-check.',
        },
      })
    )
  ).toEqual({
    command: 'pnpm typecheck && pnpm lint && pnpm test',
    projects: { web: 'pnpm --filter web check', api: 'pnpm --filter api check' },
    timeLimit: Duration.minutes(15),
    fixAttempts: 3,
    fixPrompt: 'Run /fix-check.',
  });
});

test('checkConfig reads zero fix attempts', () => {
  expect(Effect.runSync(loadCheck({ check: { command: 'make check', fixAttempts: 0 } })).fixAttempts).toBe(0);
});

test('checkConfig rejects negative fix attempts, a command with surrounding spaces, and a time limit that is not a duration', () => {
  expect(Effect.runSync(loadCheck({ check: { fixAttempts: -1 } }).pipe(Effect.flip)).cause.message).toBe(
    'Expected a value greater than or equal to 0\n  at ["check"]["fixAttempts"]'
  );
  expect(Effect.runSync(loadCheck({ check: { command: ' make check' } }).pipe(Effect.flip)).cause.message).toContain(
    'at ["check"]["command"]'
  );
  expect(Effect.runSync(loadCheck({ check: { projects: { web: 'make ' } } }).pipe(Effect.flip)).cause.message).toContain(
    'at ["check"]["projects"]["web"]'
  );
  expect(Effect.runSync(loadCheck({ check: { timeLimit: 'soon' } }).pipe(Effect.flip)).cause.message).toContain(
    'at ["check"]["timeLimit"]'
  );
});

test('checkConfig reads an empty command as no command', () => {
  expect(Effect.runSync(loadCheck({ check: { command: '', projects: { web: '' } } }))).toEqual(defaultCheckConfig);
});

test('checkCommandOf takes the override of the ticket Project, and the default command otherwise', () => {
  const check = { ...defaultCheckConfig, command: 'pnpm check', projects: { web: 'pnpm --filter web check' } };
  const web = Schema.decodeSync(Project)('web');
  const api = Schema.decodeSync(Project)('api');

  expect(checkCommandOf(check, web)).toBe('pnpm --filter web check');
  expect(checkCommandOf(check, api)).toBe('pnpm check');
  expect(checkCommandOf(check, undefined)).toBe('pnpm check');
  expect(checkCommandOf({ ...check, command: undefined }, api)).toBeUndefined();
  expect(checkCommandOf(defaultCheckConfig, undefined)).toBeUndefined();
});

const loadCommit = (entries: Record<string, unknown>) => commitConfig.parse(engineConfigProvider(entries));

test('commitConfig sends a prose commit prompt that names the ticket, on a fast low-tier model, unless set', () => {
  expect(Effect.runSync(loadCommit({}))).toEqual(defaultCommitConfig);
  expect(Effect.runSync(loadCommit({ commit: {} }))).toEqual(defaultCommitConfig);
  expect(Effect.runSync(loadCommit({ commit: { prompt: '' } }))).toEqual(defaultCommitConfig);
  expect(defaultCommitConfig).toEqual({ prompt: defaultCommitPrompt, model: { fast: true, tier: 'low' } });
  expect(defaultCommitPrompt).toContain('{{id}}');
  expect(defaultCommitPrompt).not.toMatch(/\//);
});

test('commitConfig reads the commit prompt and its model demand', () => {
  expect(
    Effect.runSync(
      loadCommit({
        commit: {
          prompt: '/commit {{project}} ticket-{{id}}: {{title}}',
          model: { tier: 'mid', fast: false, generation: 'previous' },
        },
      })
    )
  ).toEqual({
    prompt: '/commit {{project}} ticket-{{id}}: {{title}}',
    model: { tier: 'mid', fast: false, generation: 'previous' },
  });
});

test('commitConfig takes a model demand that is set in place of the default one', () => {
  expect(Effect.runSync(loadCommit({ commit: { model: { tier: 'high' } } }))).toEqual({
    prompt: defaultCommitPrompt,
    model: { tier: 'high' },
  });
});

test('commitConfig rejects an unknown model tier', () => {
  expect(Effect.runSync(loadCommit({ commit: { model: { tier: 'top' } } }).pipe(Effect.flip)).cause.message).toContain(
    'at ["commit"]["model"]["tier"]'
  );
});

const loadStrategies = (entries: Record<string, unknown>) => strategiesConfig.parse(engineConfigProvider(entries));

test('strategiesConfig reads a step with every option', () => {
  expect(
    Effect.runSync(
      loadStrategies({
        strategies: {
          implementation: [
            {
              prompt: 'Judge ticket {{id}}: {{title}}\n\n{{body}}',
              prompts: { Claude: '/acceptance-gate {{body}}', Codex: '$acceptance-gate {{body}}' },
              model: { tier: 'mid', fast: false, generation: 'current' },
              timeLimit: '15 minutes',
              retries: 2,
              verdict: true,
            },
          ],
        },
      })
    ).implementation
  ).toEqual([
    {
      prompt: 'Judge ticket {{id}}: {{title}}\n\n{{body}}',
      prompts: { Claude: '/acceptance-gate {{body}}', Codex: '$acceptance-gate {{body}}' },
      model: { tier: 'mid', fast: false, generation: 'current' },
      timeLimit: Duration.minutes(15),
      retries: 2,
      verdict: true,
    },
  ]);
});

test('strategiesConfig reads a step with only a prompt', () => {
  expect(Effect.runSync(loadStrategies({ strategies: { task: [{ prompt: 'Do {{title}}.' }] } })).task).toEqual([
    { prompt: 'Do {{title}}.' },
  ]);
});

test('strategiesConfig has the default Strategies unless set: implement and a verdict for implementation, one step for research and task', () => {
  expect(Effect.runSync(loadStrategies({}))).toEqual(defaultStrategies);
  expect(Effect.runSync(loadStrategies({ strategies: {} }))).toEqual(defaultStrategies);
  expect(Object.keys(defaultStrategies).toSorted()).toEqual(['implementation', 'research', 'task']);
  const [implement, verdict] = defaultStrategies.implementation!;
  expect(implement!.verdict).toBeUndefined();
  expect(verdict).toMatchObject({ verdict: true, timeLimit: Duration.minutes(10), retries: 1 });
  expect(verdict!.prompt).toContain('acceptance criteria');
  expect(defaultStrategies.implementation).toHaveLength(2);
  expect(defaultStrategies.research).toHaveLength(1);
  expect(defaultStrategies.task).toHaveLength(1);
});

test('strategiesConfig replaces the default Strategy of a configured Ticket Kind and keeps the other defaults', () => {
  const strategies = Effect.runSync(
    loadStrategies({ strategies: { implementation: [{ prompt: 'Build it.' }], grilling: [{ prompt: 'Grill me.' }] } })
  );

  expect(strategies).toEqual({
    ...defaultStrategies,
    implementation: [{ prompt: 'Build it.' }],
    grilling: [{ prompt: 'Grill me.' }],
  });
});

test('strategiesConfig rejects an empty Strategy, a step without a prompt, negative retries, and a bad time limit', () => {
  const failureOf = (strategies: unknown) =>
    Effect.runSync(loadStrategies({ strategies }).pipe(Effect.flip)).cause.message;

  expect(failureOf({ implementation: [] })).toContain('at ["strategies"]["implementation"]');
  expect(failureOf({ implementation: [{ verdict: true }] })).toContain('at ["strategies"]["implementation"][0]["prompt"]');
  expect(failureOf({ task: [{ prompt: 'Do it.', retries: -1 }] })).toContain('at ["strategies"]["task"][0]["retries"]');
  expect(failureOf({ task: [{ prompt: 'Do it.', timeLimit: 'soon' }] })).toContain('at ["strategies"]["task"][0]["timeLimit"]');
});
