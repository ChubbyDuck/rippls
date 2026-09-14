import * as NodePath from '@effect/platform-node/NodePath';
import { ConfigProvider, Effect, Layer } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, test } from 'vitest';

import { RepositoryRoot } from '~/Core/Shared/Domain/RepositoryRoot';
import { AgentRepository } from '~/Core/Shared/Ports/AgentRepository';

import { ConfiguredAgentsLive } from './configured';

const namesOf = (agents: ReadonlyArray<{ readonly name: string }>) => agents.map((agent) => agent.name);

const withAgents = (entries: Record<string, unknown>) =>
  ConfiguredAgentsLive.pipe(
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(entries))),
    Layer.provide(Layer.mergeAll(Layer.succeed(RepositoryRoot, '/repo'), NodePath.layer))
  );

const take = (count: number, entries: Record<string, unknown>) =>
  namesOf(
    Effect.runSync(
      AgentRepository.pipe(
        Effect.flatMap((repo) => Effect.replicateEffect(repo.getOne, count)),
        Effect.provide(withAgents(entries))
      )
    )
  );

test('AgentRepository.getOne always returns the only configured agent', () => {
  expect(take(3, { agents: [{ name: 'Codex' }] })).toEqual(['Codex', 'Codex', 'Codex']);
});

test('AgentRepository.getOne round-robins agents that omit priority', () => {
  expect(take(6, { agents: [{ name: 'Codex' }, { name: 'Cursor' }] })).toEqual([
    'Codex',
    'Cursor',
    'Codex',
    'Cursor',
    'Codex',
    'Cursor',
  ]);
  expect(take(6, { agents: [{ name: 'Codex' }, { name: 'Cursor' }, { name: 'Claude' }] })).toEqual([
    'Codex',
    'Cursor',
    'Claude',
    'Codex',
    'Cursor',
    'Claude',
  ]);
});

test('AgentRepository.getOne follows the weighted priority cycle', () => {
  expect(
    take(6, {
      agents: [
        { name: 'Codex', priority: 2 },
        { name: 'Cursor', priority: 1 },
      ],
    })
  ).toEqual(['Codex', 'Codex', 'Cursor', 'Codex', 'Codex', 'Cursor']);
  expect(
    take(10, {
      agents: [
        { name: 'Codex', priority: 40 },
        { name: 'Cursor', priority: 30 },
        { name: 'Claude', priority: 20 },
        { name: 'OpenCode', priority: 10 },
      ],
    })
  ).toEqual(['Codex', 'Codex', 'Cursor', 'Claude', 'OpenCode', 'Codex', 'Cursor', 'Claude', 'Codex', 'Cursor']);
});

test('AgentRepository.getOne uses every registered agent when agents are absent', () => {
  expect(take(8, {})).toEqual(['Codex', 'Cursor', 'Claude', 'OpenCode', 'Codex', 'Cursor', 'Claude', 'OpenCode']);
});

const hourlyAtTen = {
  freq: 'HOURLY',
  dtstart: '2026-01-01T00:00:00.000Z',
  byhour: [10],
};

const takeAt = (count: number, entries: Record<string, unknown>, time: number) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(time);
      return yield* AgentRepository.pipe(Effect.flatMap((repo) => Effect.replicateEffect(repo.getOne, count)));
    }).pipe(Effect.provide(Layer.mergeAll(withAgents(entries), TestClock.layer())))
  ).then(namesOf);

test('AgentRepository.getOne uses scheduled agents while the current time is in range', async () => {
  const entries = {
    agents: [{ name: 'Codex' }],
    schedule: [{ agents: [{ name: 'Cursor' }], rrule: hourlyAtTen }],
  };

  expect(await takeAt(2, entries, Date.UTC(2026, 0, 1, 10, 30))).toEqual(['Cursor', 'Cursor']);
  expect(await takeAt(2, entries, Date.UTC(2026, 0, 1, 11, 0))).toEqual(['Codex', 'Codex']);
});

test('AgentRepository.getOne uses a daily from/to rule in the named time zone', async () => {
  const entries = {
    agents: [{ name: 'Codex' }],
    schedule: [
      {
        agents: [{ name: 'Cursor' }],
        rule: { freq: 'DAILY', from: '18:00', to: '09:00', tzid: 'Europe/Sofia' },
      },
    ],
  };

  expect(await takeAt(1, entries, Date.parse('2026-09-07T16:45:00.000Z'))).toEqual(['Cursor']);
  expect(await takeAt(1, entries, Date.parse('2026-09-07T14:30:00.000Z'))).toEqual(['Codex']);
  expect(await takeAt(1, entries, Date.parse('2026-09-08T05:30:00.000Z'))).toEqual(['Cursor']);
  expect(await takeAt(1, entries, Date.parse('2026-09-08T06:00:00.000Z'))).toEqual(['Codex']);
});

test('AgentRepository.getOne uses a same-day from/to rule in the named time zone', async () => {
  const entries = {
    agents: [{ name: 'Codex' }],
    schedule: [
      {
        agents: [{ name: 'Cursor' }],
        rule: { freq: 'DAILY', from: '14:00', to: '19:00', tzid: 'Europe/Sofia' },
      },
    ],
  };

  expect(await takeAt(1, entries, Date.parse('2026-09-07T11:00:00.000Z'))).toEqual(['Cursor']);
  expect(await takeAt(1, entries, Date.parse('2026-09-07T13:30:00.000Z'))).toEqual(['Cursor']);
  expect(await takeAt(1, entries, Date.parse('2026-09-07T16:00:00.000Z'))).toEqual(['Codex']);
  expect(await takeAt(1, entries, Date.parse('2026-09-07T10:59:00.000Z'))).toEqual(['Codex']);
});

test('AgentRepository.getOne uses daily byhour islands only during those hours', async () => {
  const entries = {
    agents: [{ name: 'Codex' }],
    schedule: [
      {
        agents: [{ name: 'Cursor' }],
        rrule: {
          freq: 'DAILY',
          dtstart: '2026-01-01T00:00:00.000Z',
          byhour: [0, 1, 2, 3, 4, 5, 6, 7, 8],
        },
      },
    ],
  };

  expect(await takeAt(1, entries, Date.UTC(2026, 0, 1, 8, 30))).toEqual(['Cursor']);
  expect(await takeAt(1, entries, Date.UTC(2026, 0, 1, 9, 0))).toEqual(['Codex']);
});

test('AgentRepository.getOne uses the first scheduled island that covers the current time', async () => {
  expect(
    await takeAt(
      1,
      {
        agents: [{ name: 'Codex' }],
        schedule: [
          { agents: [{ name: 'Cursor' }], rrule: hourlyAtTen },
          {
            agents: [{ name: 'Claude' }],
            rrule: { freq: 'HOURLY', dtstart: '2026-01-01T00:00:00.000Z', byhour: [10, 11] },
          },
        ],
      },
      Date.UTC(2026, 0, 1, 10, 15)
    )
  ).toEqual(['Cursor']);
});
