import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { Effect, FileSystem, Layer, Path } from 'effect';
import { expect, test } from 'vitest';

import type { Ticket } from '~/Core/Tickets/Domain/Entities/Ticket/entity';
import { Hitl } from '~/Core/Tickets/Domain/Entities/Ticket/properties/Hitl';
import { TicketKind } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketKind';
import { TicketStatus } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketStatus';
import { FixtureWriter } from '~/Core/Tickets/Ports/FixtureWriter';
import { fixtureWriterFolderLive } from '~/Infrastructure/Tickets/FixtureWriter/folder';

import { generateTickets } from './generate';
import type { GenerateOptions } from './plan';

const defaults: GenerateOptions = { count: 36, kinds: [], statuses: [], hitls: [], projects: [], chain: false };

const runGenerate = (options: Partial<GenerateOptions>) => {
  const saved: Ticket[] = [];
  const writer = Layer.succeed(FixtureWriter, {
    write: (tickets) =>
      Effect.sync(() => {
        saved.push(...tickets);
      }),
  });
  return Effect.runPromise(
    generateTickets({ ...defaults, ...options }).pipe(
      Effect.map((created) => ({ created, saved })),
      Effect.provide(writer)
    )
  );
};

test('generateTickets saves the requested amount with sequential ids', async () => {
  const { created, saved } = await runGenerate({ count: 20 });

  expect(created).toBe(20);
  expect(saved.length).toBe(20);
  expect(saved.map((ticket) => ticket.id)).toEqual(
    Array.from({ length: 20 }, (_unused, index) => `folder:${index + 1}`)
  );
  expect(saved[0]?.body).toBe('Reply with hello.');
  for (const ticket of saved) {
    expect(ticket.body.length).toBeGreaterThan(0);
  }
});

test('generateTickets spreads every kind, hitl and status by default', async () => {
  const { saved } = await runGenerate({ count: 36 });

  expect(new Set(saved.map((ticket) => ticket.kind))).toEqual(new Set(TicketKind.literals));
  expect(new Set(saved.map((ticket) => ticket.hitl))).toEqual(new Set(Hitl.literals));
  expect(new Set(saved.map((ticket) => ticket.status))).toEqual(new Set(TicketStatus.literals));
});

test('generateTickets honors the app rules when it derives hitl from kind', async () => {
  const { saved } = await runGenerate({ count: 12, kinds: ['prototype'] });

  expect(new Set(saved.map((ticket) => ticket.kind))).toEqual(new Set(['prototype']));
  expect(new Set(saved.map((ticket) => ticket.hitl))).toEqual(new Set(['yes']));
});

test('generateTickets limits attributes to the given subsets', async () => {
  const { saved } = await runGenerate({
    count: 10,
    kinds: ['task'],
    statuses: ['open'],
    hitls: ['no'],
    projects: ['alpha'],
  });

  for (const ticket of saved) {
    expect(ticket.kind).toBe('task');
    expect(ticket.status).toBe('open');
    expect(ticket.hitl).toBe('no');
    expect(ticket.project).toBe('alpha');
  }
});

test('generateTickets leaves tickets unlinked by default', async () => {
  const { saved } = await runGenerate({ count: 3 });

  for (const ticket of saved) {
    expect(ticket.blockedBy).toEqual([]);
    expect(ticket.blocks).toEqual([]);
  }
});

test('generateTickets chains each ticket to the next when chain is true', async () => {
  const { saved } = await runGenerate({ count: 4, chain: true });

  expect(
    saved.map((ticket) => ({
      id: ticket.id,
      blockedBy: [...ticket.blockedBy],
      blocks: [...ticket.blocks],
    }))
  ).toEqual([
    { id: 'folder:1', blockedBy: [], blocks: ['folder:2'] },
    { id: 'folder:2', blockedBy: ['folder:1'], blocks: ['folder:3'] },
    { id: 'folder:3', blockedBy: ['folder:2'], blocks: ['folder:4'] },
    { id: 'folder:4', blockedBy: ['folder:3'], blocks: [] },
  ]);
});

test('generateTickets fails when the kind and hitl constraints contradict', async () => {
  const error = await Effect.runPromise(
    generateTickets({ ...defaults, kinds: ['implementation'], hitls: ['yes'] }).pipe(
      Effect.flip,
      Effect.provide(Layer.succeed(FixtureWriter, { write: () => Effect.void }))
    )
  );

  expect(error._tag).toBe('NoTicketMatchesConstraints');
});

// Writes the fixtures into a temporary folder and returns every file under it by relative path.
const generateFiles = (options: Partial<GenerateOptions>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectory({ prefix: 'rippls-generate-' });
      yield* generateTickets({ ...defaults, ...options }).pipe(Effect.provide(fixtureWriterFolderLive(dir)));
      const names = yield* fs.readDirectory(dir, { recursive: true });
      const files = names.filter((name) => name.endsWith('.md')).toSorted();
      const contents = yield* Effect.forEach(files, (name) => fs.readFileString(path.join(dir, name)));
      return Object.fromEntries(files.map((name, index) => [name, contents[index]]));
    }).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)))
  );

test('generateTickets writes the same folder fixture files as before, with a dependency chain', async () => {
  const files = await generateFiles({ count: 4, chain: true });

  expect(files).toEqual({
    '1.md': [
      '---',
      'id: 1',
      'title: Generated ticket 1',
      'project: generated',
      'status: open',
      'kind: implementation',
      'hitl: no',
      'blockedBy: []',
      'blocks:',
      '  - 2',
      '---',
      '',
      'Reply with hello.',
    ].join('\n'),
    '2.md': [
      '---',
      'id: 2',
      'title: Generated ticket 2',
      'project: generated',
      'status: ready-for-agent',
      'kind: research',
      'hitl: no',
      'blockedBy:',
      '  - 1',
      'blocks:',
      '  - 3',
      '---',
      '',
      'What is 2 + 2?',
    ].join('\n'),
    'done/3.md': [
      '---',
      'id: 3',
      'title: Generated ticket 3',
      'project: generated',
      'status: done',
      'kind: prototype',
      'hitl: yes',
      'blockedBy:',
      '  - 2',
      'blocks:',
      '  - 4',
      '---',
      '',
      'Name one color.',
    ].join('\n'),
    '4.md': [
      '---',
      'id: 4',
      'title: Generated ticket 4',
      'project: generated',
      'status: resolved',
      'kind: grilling',
      'hitl: yes',
      'blockedBy:',
      '  - 3',
      'blocks: []',
      '---',
      '',
      'Say yes.',
    ].join('\n'),
  });
});

test('generateTickets writes the same folder fixture files as before for the given subsets', async () => {
  const files = await generateFiles({
    count: 2,
    kinds: ['task'],
    statuses: ['blocked'],
    hitls: ['yes'],
    projects: ['alpha'],
  });

  expect(files).toEqual({
    '1.md': [
      '---',
      'id: 1',
      'title: Generated ticket 1',
      'project: alpha',
      'status: blocked',
      'kind: task',
      'hitl: yes',
      'blockedBy: []',
      'blocks: []',
      '---',
      '',
      'Reply with hello.',
    ].join('\n'),
    '2.md': [
      '---',
      'id: 2',
      'title: Generated ticket 2',
      'project: alpha',
      'status: blocked',
      'kind: task',
      'hitl: yes',
      'blockedBy: []',
      'blocks: []',
      '---',
      '',
      'What is 2 + 2?',
    ].join('\n'),
  });
});
