import * as NodePath from '@effect/platform-node/NodePath';
import { ConfigProvider, Effect, Layer } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, test } from 'vitest';

import { RepositoryRoot } from '~/Core/Shared/Domain/RepositoryRoot';
import { HarnessSelector } from '~/Core/Shared/Ports/HarnessSelector';

import { ConfiguredHarnessesLive } from './configured';

const namesOf = (harnesses: ReadonlyArray<{ readonly name: string }>) => harnesses.map((harness) => harness.name);

const withHarnesses = (entries: Record<string, unknown>) =>
  ConfiguredHarnessesLive.pipe(
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(entries))),
    Layer.provide(Layer.mergeAll(Layer.succeed(RepositoryRoot, '/repo'), NodePath.layer))
  );

const take = (count: number, entries: Record<string, unknown>) =>
  namesOf(
    Effect.runSync(
      HarnessSelector.pipe(
        Effect.flatMap((selector) => Effect.replicateEffect(selector.select, count)),
        Effect.provide(withHarnesses(entries))
      )
    )
  );

test('HarnessSelector.select always returns the only configured harness', () => {
  expect(take(3, { harnesses: [{ name: 'Codex' }] })).toEqual(['Codex', 'Codex', 'Codex']);
});

test('HarnessSelector.select round-robins harnesses that omit priority', () => {
  expect(take(6, { harnesses: [{ name: 'Codex' }, { name: 'Cursor' }] })).toEqual([
    'Codex',
    'Cursor',
    'Codex',
    'Cursor',
    'Codex',
    'Cursor',
  ]);
  expect(take(6, { harnesses: [{ name: 'Codex' }, { name: 'Cursor' }, { name: 'Claude' }] })).toEqual([
    'Codex',
    'Cursor',
    'Claude',
    'Codex',
    'Cursor',
    'Claude',
  ]);
});

test('HarnessSelector.select follows the weighted priority cycle', () => {
  expect(
    take(6, {
      harnesses: [
        { name: 'Codex', priority: 2 },
        { name: 'Cursor', priority: 1 },
      ],
    })
  ).toEqual(['Codex', 'Codex', 'Cursor', 'Codex', 'Codex', 'Cursor']);
  expect(
    take(10, {
      harnesses: [
        { name: 'Codex', priority: 40 },
        { name: 'Cursor', priority: 30 },
        { name: 'Claude', priority: 20 },
        { name: 'OpenCode', priority: 10 },
      ],
    })
  ).toEqual(['Codex', 'Codex', 'Cursor', 'Claude', 'OpenCode', 'Codex', 'Cursor', 'Claude', 'Codex', 'Cursor']);
});

test('HarnessSelector.select uses every registered harness when harnesses are absent', () => {
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
      return yield* HarnessSelector.pipe(Effect.flatMap((selector) => Effect.replicateEffect(selector.select, count)));
    }).pipe(Effect.provide(Layer.mergeAll(withHarnesses(entries), TestClock.layer())))
  ).then(namesOf);

test('HarnessSelector.select uses scheduled harnesses while the current time is in range', async () => {
  const entries = {
    harnesses: [{ name: 'Codex' }],
    schedule: [{ harnesses: [{ name: 'Cursor' }], rrule: hourlyAtTen }],
  };

  expect(await takeAt(2, entries, Date.UTC(2026, 0, 1, 10, 30))).toEqual(['Cursor', 'Cursor']);
  expect(await takeAt(2, entries, Date.UTC(2026, 0, 1, 11, 0))).toEqual(['Codex', 'Codex']);
});

test('HarnessSelector.select uses a daily from/to rule in the named time zone', async () => {
  const entries = {
    harnesses: [{ name: 'Codex' }],
    schedule: [
      {
        harnesses: [{ name: 'Cursor' }],
        rule: { freq: 'DAILY', from: '18:00', to: '09:00', tzid: 'Europe/Sofia' },
      },
    ],
  };

  expect(await takeAt(1, entries, Date.parse('2026-09-07T16:45:00.000Z'))).toEqual(['Cursor']);
  expect(await takeAt(1, entries, Date.parse('2026-09-07T14:30:00.000Z'))).toEqual(['Codex']);
  expect(await takeAt(1, entries, Date.parse('2026-09-08T05:30:00.000Z'))).toEqual(['Cursor']);
  expect(await takeAt(1, entries, Date.parse('2026-09-08T06:00:00.000Z'))).toEqual(['Codex']);
});

test('HarnessSelector.select uses a same-day from/to rule in the named time zone', async () => {
  const entries = {
    harnesses: [{ name: 'Codex' }],
    schedule: [
      {
        harnesses: [{ name: 'Cursor' }],
        rule: { freq: 'DAILY', from: '14:00', to: '19:00', tzid: 'Europe/Sofia' },
      },
    ],
  };

  expect(await takeAt(1, entries, Date.parse('2026-09-07T11:00:00.000Z'))).toEqual(['Cursor']);
  expect(await takeAt(1, entries, Date.parse('2026-09-07T13:30:00.000Z'))).toEqual(['Cursor']);
  expect(await takeAt(1, entries, Date.parse('2026-09-07T16:00:00.000Z'))).toEqual(['Codex']);
  expect(await takeAt(1, entries, Date.parse('2026-09-07T10:59:00.000Z'))).toEqual(['Codex']);
});

test('HarnessSelector.select uses daily byhour islands only during those hours', async () => {
  const entries = {
    harnesses: [{ name: 'Codex' }],
    schedule: [
      {
        harnesses: [{ name: 'Cursor' }],
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

test('HarnessSelector.select uses the first scheduled island that covers the current time', async () => {
  expect(
    await takeAt(
      1,
      {
        harnesses: [{ name: 'Codex' }],
        schedule: [
          { harnesses: [{ name: 'Cursor' }], rrule: hourlyAtTen },
          {
            harnesses: [{ name: 'Claude' }],
            rrule: { freq: 'HOURLY', dtstart: '2026-01-01T00:00:00.000Z', byhour: [10, 11] },
          },
        ],
      },
      Date.UTC(2026, 0, 1, 10, 15)
    )
  ).toEqual(['Cursor']);
});
