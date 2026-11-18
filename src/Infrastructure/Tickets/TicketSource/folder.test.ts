import { ConfigProvider, Effect, FileSystem, Layer, Option, Path } from 'effect';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { expect, test } from 'vitest';

import { Ticket } from '~/Core/Tickets/Domain/Entities/Ticket/entity';
import { formatTicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';
import type { TicketEvent } from '~/Core/Tickets/Domain/Events/TicketEvent';
import { TicketQuery } from '~/Core/Tickets/Domain/Queries/TicketQuery';
import { completeTicket } from '~/Core/Tickets/Application/UseCases/CompleteTicket/completeTicket';
import { generateTickets } from '~/Core/Tickets/Application/UseCases/Generate/generate';
import { fixtureWriterFolderLive } from '~/Infrastructure/Tickets/FixtureWriter/folder';
import { TicketSource } from '~/Core/Tickets/Ports/TicketSource';

import { TicketSourceFolderLive } from './folder';

const NodeFs = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

const frontMatter = (fields: Record<string, unknown>): string => {
  const lines = Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
  return `---\n${lines.join('\n')}\n---\n`;
};

const withDir = (folder: string) =>
  TicketSourceFolderLive.pipe(
    Layer.provide(
      ConfigProvider.layer(ConfigProvider.fromUnknown({ harnesses: [{ name: 'Cursor' }], ticketsDir: folder }))
    )
  );

const setup = (files: ReadonlyArray<readonly [string, string]>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectory({ prefix: 'engine-tickets-' });
    yield* Effect.forEach(files, ([name, content]) => fs.writeFileString(path.join(dir, name), content));
    return dir;
  });

const getOneIn = (dir: string, query = TicketQuery.build()) =>
  TicketSource.pipe(
    Effect.flatMap((source) => source.getOneBy(query)),
    Effect.option,
    Effect.provide(withDir(dir))
  );

const getManyIn = (dir: string, query = TicketQuery.build()) =>
  TicketSource.pipe(
    Effect.flatMap((source) => source.getManyBy(query)),
    Effect.provide(withDir(dir))
  );

test('folder source namespaces ids in memory and writes numbers on disk', async () => {
  const saved = Ticket.create({
    id: formatTicketId('folder', '6'),
    title: 'Namespaced',
    project: 'demo',
    kind: 'task',
    hitl: 'yes',
    status: 'ready-for-agent',
    blockedBy: [formatTicketId('folder', '5')],
    blocks: [],
    body: '',
  });

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* setup([
        [
          '6.md',
          frontMatter({
            id: 6,
            title: 'Namespaced',
            project: 'demo',
            kind: 'implementation',
            status: 'ready-for-agent',
            blockedBy: [5],
            blocks: [],
          }) + 'Keep the body.\n',
        ],
      ]);

      const before = yield* getOneIn(dir);
      yield* TicketSource.pipe(
        Effect.flatMap((source) => source.save(saved)),
        Effect.provide(withDir(dir))
      );
      const content = yield* fs.readFileString(path.join(dir, '6.md'));
      const after = yield* getOneIn(dir);
      return { before, content, after };
    }).pipe(Effect.provide(NodeFs))
  );

  expect(Option.getOrThrow(result.before).id).toBe('folder:6');
  expect(Option.getOrThrow(result.before).blockedBy).toEqual(['folder:5']);
  expect(result.content).toContain('id: 6');
  expect(result.content).toContain('5');
  expect(result.content).not.toContain('folder:');
  expect(result.content).toContain('Keep the body.');
  expect(Option.getOrThrow(result.after).id).toBe('folder:6');
  expect(Option.getOrThrow(result.after).blockedBy).toEqual(['folder:5']);
  expect(Option.getOrThrow(result.after).kind).toBe('task');
});

test('getOneBy decodes a schema-shaped front matter file', async () => {
  const ticket = await Effect.runPromise(
    Effect.gen(function* () {
      const dir = yield* setup([
        [
          '1.md',
          frontMatter({
            id: 1,
            title: 'First ticket',
            project: 'demo',
            kind: 'implementation',
            status: 'ready-for-agent',
            blockedBy: [],
            blocks: [],
          }) + '# body\n',
        ],
      ]);
      return yield* getOneIn(dir);
    }).pipe(Effect.provide(NodeFs))
  );

  expect(Option.isSome(ticket)).toBe(true);
  expect(Option.getOrThrow(ticket).id).toBe('folder:1');
  expect(Option.getOrThrow(ticket).hitl).toBe('no');
  expect(Option.getOrThrow(ticket).body).toBe('# body\n');
});

test('getOneBy decodes a ticket that omits project', async () => {
  const ticket = await Effect.runPromise(
    Effect.gen(function* () {
      const dir = yield* setup([
        [
          '1.md',
          frontMatter({
            id: 1,
            title: 'No project',
            kind: 'implementation',
            status: 'ready-for-agent',
            blockedBy: [],
            blocks: [],
          }),
        ],
      ]);
      return yield* getOneIn(dir);
    }).pipe(Effect.provide(NodeFs))
  );

  expect(Option.getOrThrow(ticket).id).toBe('folder:1');
  expect(Option.getOrThrow(ticket).project).toBeUndefined();
});

test('getOneBy ignores invalid front matter and non-md files', async () => {
  const ticket = await Effect.runPromise(
    Effect.gen(function* () {
      const dir = yield* setup([
        ['1.md', '---\nnot: a ticket\n---\n'],
        [
          'note.txt',
          frontMatter({ id: 2, title: 'x', project: 'p', kind: 'task', hitl: 'no', status: 'open', blockedBy: [], blocks: [] }),
        ],
        [
          '3.md',
          frontMatter({
            id: 3,
            title: 'Valid ticket',
            project: 'demo',
            kind: 'implementation',
            status: 'ready-for-agent',
            blockedBy: [],
            blocks: [],
          }),
        ],
      ]);
      return yield* getOneIn(dir);
    }).pipe(Effect.provide(NodeFs))
  );

  expect(Option.getOrThrow(ticket).id).toBe('folder:3');
});

test('getOneBy accepts a leading-id slug filename and ignores names that do not start with a number', async () => {
  const common = { project: 'demo', kind: 'implementation', status: 'ready-for-agent', blockedBy: [], blocks: [] };
  const ticket = await Effect.runPromise(
    Effect.gen(function* () {
      const dir = yield* setup([
        ['ticket-1.md', frontMatter({ id: 1, title: 'not leading', ...common })],
        ['2-restore-money-dev-fast-refresh.md', frontMatter({ id: 2, title: 'slugged', ...common }) + '# slugged body\n'],
      ]);
      return yield* getOneIn(dir);
    }).pipe(Effect.provide(NodeFs))
  );

  expect(Option.getOrThrow(ticket).id).toBe('folder:2');
  expect(Option.getOrThrow(ticket).body).toBe('# slugged body\n');
});

test('save updates a slugged filename in place and moves it to done with the same name', async () => {
  const createdFields = {
    id: formatTicketId('folder', '9'),
    title: 'Slugged save',
    project: 'demo',
    kind: 'implementation',
    status: 'ready-for-agent',
    blockedBy: [],
    blocks: [],
    body: '',
  } as const;
  const created = Ticket.create(createdFields);
  const done = created.done();

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* setup([
        [
          '9-slugged-save.md',
          frontMatter({
            id: 9,
            title: 'Slugged save',
            project: 'demo',
            kind: 'implementation',
            status: 'ready-for-agent',
            blockedBy: [],
            blocks: [],
          }) + 'Keep this body.\n',
        ],
      ]);

      yield* TicketSource.pipe(
        Effect.flatMap((source) => source.save(Ticket.create({ ...createdFields, kind: 'task', hitl: 'yes' }))),
        Effect.provide(withDir(dir))
      );
      const escalated = yield* fs.readFileString(path.join(dir, '9-slugged-save.md'));
      const numericExistsAfterEscalation = yield* fs.exists(path.join(dir, '9.md'));

      yield* TicketSource.pipe(
        Effect.flatMap((source) => source.save(done)),
        Effect.provide(withDir(dir))
      );
      const originalExists = yield* fs.exists(path.join(dir, '9-slugged-save.md'));
      const doneContent = yield* fs.readFileString(path.join(dir, 'done', '9-slugged-save.md'));
      return { escalated, numericExistsAfterEscalation, originalExists, doneContent };
    }).pipe(Effect.provide(NodeFs))
  );

  expect(result.escalated).toContain('kind: task');
  expect(result.escalated).toContain('Keep this body.');
  expect(result.numericExistsAfterEscalation).toBe(false);
  expect(result.originalExists).toBe(false);
  expect(result.doneContent).toContain('status: done');
  expect(result.doneContent).toContain('Keep this body.');
});

test('getManyBy returns every ticket in scope by numeric filename prefix, lowest first', async () => {
  const common = { project: 'demo', kind: 'implementation', blocks: [] };
  const tickets = await Effect.runPromise(
    Effect.gen(function* () {
      const dir = yield* setup([
        ['10-ready.md', frontMatter({ id: 10, title: 'ready', status: 'ready-for-agent', blockedBy: [], ...common })],
        ['2-claimed.md', frontMatter({ id: 2, title: 'claimed', status: 'claimed', claimedBy: 'runner-1', blockedBy: [], ...common })],
        ['1-blocked.md', frontMatter({ id: 1, title: 'blocked', status: 'blocked', blockedBy: [9], ...common })],
        ['3-claiming.md', frontMatter({ id: 3, title: 'claiming', status: 'claiming', blockedBy: [], ...common })],
        ['4-attended.md', frontMatter({ id: 4, title: 'attended', status: 'ready-for-agent', blockedBy: [], ...common, kind: 'prototype' })],
      ]);
      return yield* getManyIn(dir, TicketQuery.build());
    }).pipe(Effect.provide(NodeFs))
  );

  expect(tickets.map((ticket) => ticket.id)).toEqual(['folder:1', 'folder:2', 'folder:3', 'folder:4', 'folder:10']);
});

test('getManyBy narrows by Project and keeps the processing order', async () => {
  const common = { kind: 'implementation', status: 'ready-for-agent', blocks: [] };
  const tickets = await Effect.runPromise(
    Effect.gen(function* () {
      const dir = yield* setup([
        ['5.md', frontMatter({ id: 5, title: 'wanted later', project: 'wanted', blockedBy: [], ...common })],
        ['1.md', frontMatter({ id: 1, title: 'other', project: 'other', blockedBy: [], ...common })],
        ['2.md', frontMatter({ id: 2, title: 'no project', blockedBy: [], ...common })],
        ['3.md', frontMatter({ id: 3, title: 'wanted blocked', project: 'wanted', blockedBy: [1], ...common })],
      ]);
      return yield* getManyIn(dir, TicketQuery.byProject('wanted' as never).build());
    }).pipe(Effect.provide(NodeFs))
  );

  expect(tickets.map((ticket) => ticket.id)).toEqual(['folder:3', 'folder:5']);
});

test('completing a ticket leaves its dependent byte for byte unchanged and reads it as done from done/', async () => {
  const common = { project: 'demo', kind: 'implementation', blocks: [] };
  const dependent =
    frontMatter({ id: 2, title: 'dependent', status: 'blocked', blockedBy: [1], ...common }) + '# Dependent\n\nKeep me.\n';
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* setup([
        ['1-blocker.md', frontMatter({ id: 1, title: 'blocker', status: 'claimed', claimedBy: 'runner-1', blockedBy: [], ...common })],
        ['2-dependent.md', dependent],
      ]);
      yield* completeTicket({ ticketId: formatTicketId('folder', '1') }).pipe(Effect.provide(withDir(dir)));
      const after = yield* fs.readFileString(path.join(dir, '2-dependent.md'));
      const tickets = yield* getManyIn(dir, TicketQuery.build());
      return { after, tickets };
    }).pipe(Effect.provide(NodeFs))
  );

  expect(result.after).toBe(dependent);
  expect(result.tickets.map((ticket) => [ticket.id, ticket.status])).toEqual([
    ['folder:2', 'blocked'],
    ['folder:1', 'done'],
  ]);
  expect(result.tickets[0]?.blockedBy).toEqual(['folder:1']);
});

test('getManyBy reads a ticket in done/ as done whatever its front matter says', async () => {
  const common = { project: 'demo', kind: 'implementation', blocks: [], blockedBy: [] };
  const tickets = await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* setup([['3.md', frontMatter({ id: 3, title: 'open', status: 'ready-for-agent', ...common })]]);
      yield* fs.makeDirectory(path.join(dir, 'done'));
      yield* fs.writeFileString(
        path.join(dir, 'done', '1-moved-by-hand.md'),
        frontMatter({ id: 1, title: 'moved by hand', status: 'ready-for-agent', ...common })
      );
      yield* fs.writeFileString(path.join(dir, 'done', 'notes.md'), 'Not a ticket.\n');
      return yield* getManyIn(dir, TicketQuery.build());
    }).pipe(Effect.provide(NodeFs))
  );

  expect(tickets.map((ticket) => [ticket.id, ticket.status])).toEqual([
    ['folder:3', 'ready-for-agent'],
    ['folder:1', 'done'],
  ]);
});

test('getManyBy narrows the done tickets by Project too', async () => {
  const common = { kind: 'implementation', status: 'done', blocks: [], blockedBy: [] };
  const tickets = await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* setup([]);
      yield* fs.makeDirectory(path.join(dir, 'done'));
      yield* fs.writeFileString(path.join(dir, 'done', '1.md'), frontMatter({ id: 1, title: 'wanted', project: 'wanted', ...common }));
      yield* fs.writeFileString(path.join(dir, 'done', '2.md'), frontMatter({ id: 2, title: 'other', project: 'other', ...common }));
      return yield* getManyIn(dir, TicketQuery.byProject('wanted' as never).build());
    }).pipe(Effect.provide(NodeFs))
  );

  expect(tickets.map((ticket) => ticket.id)).toEqual(['folder:1']);
});

test('getOneBy follows the id sort', async () => {
  const common = { project: 'demo', kind: 'implementation', status: 'ready-for-agent', blockedBy: [], blocks: [] };
  const build = (query: TicketQuery) =>
    Effect.gen(function* () {
      const dir = yield* setup([
        ['3.md', frontMatter({ id: 3, title: 'low', ...common })],
        ['4.md', frontMatter({ id: 4, title: 'high', ...common })],
      ]);
      return yield* getOneIn(dir, query);
    }).pipe(Effect.provide(NodeFs));

  expect(Option.getOrThrow(await Effect.runPromise(build(TicketQuery.sort('ASC').build()))).id).toBe('folder:3');
  expect(Option.getOrThrow(await Effect.runPromise(build(TicketQuery.sort('DESC').build()))).id).toBe('folder:4');
});

test('getOneBy filters by project', async () => {
  const common = { kind: 'implementation', status: 'ready-for-agent', blockedBy: [], blocks: [] };
  const ticket = await Effect.runPromise(
    Effect.gen(function* () {
      const dir = yield* setup([
        ['1.md', frontMatter({ id: 1, title: 'other', project: 'other', ...common })],
        ['2.md', frontMatter({ id: 2, title: 'wanted', project: 'wanted', ...common })],
      ]);
      return yield* getOneIn(dir, TicketQuery.byProject('wanted' as never).build());
    }).pipe(Effect.provide(NodeFs))
  );

  expect(Option.getOrThrow(ticket).id).toBe('folder:2');
});

test('getOneBy by project skips a ticket that omits project', async () => {
  const common = { kind: 'implementation', status: 'ready-for-agent', blockedBy: [], blocks: [] };
  const ticket = await Effect.runPromise(
    Effect.gen(function* () {
      const dir = yield* setup([
        ['1.md', frontMatter({ id: 1, title: 'no project', ...common })],
        ['2.md', frontMatter({ id: 2, title: 'wanted', project: 'wanted', ...common })],
      ]);
      return yield* getOneIn(dir, TicketQuery.byProject('wanted' as never).build());
    }).pipe(Effect.provide(NodeFs))
  );

  expect(Option.getOrThrow(ticket).id).toBe('folder:2');
});

test('getOneBy without a project returns a ticket that omits project', async () => {
  const common = { kind: 'implementation', status: 'ready-for-agent', blockedBy: [], blocks: [] };
  const ticket = await Effect.runPromise(
    Effect.gen(function* () {
      const dir = yield* setup([
        ['1.md', frontMatter({ id: 1, title: 'no project', ...common })],
        ['2.md', frontMatter({ id: 2, title: 'named', project: 'demo', ...common })],
      ]);
      return yield* getOneIn(dir);
    }).pipe(Effect.provide(NodeFs))
  );

  expect(Option.getOrThrow(ticket).id).toBe('folder:1');
  expect(Option.getOrThrow(ticket).project).toBeUndefined();
});

test('getOneBy reads only the head of a file with a large body', async () => {
  const body = 'x'.repeat(200_000);
  const ticket = await Effect.runPromise(
    Effect.gen(function* () {
      const dir = yield* setup([
        [
          '7.md',
          frontMatter({
            id: 7,
            title: 'Large body',
            project: 'demo',
            kind: 'implementation',
            status: 'ready-for-agent',
            blockedBy: [],
            blocks: [],
          }) + body,
        ],
      ]);
      return yield* getOneIn(dir);
    }).pipe(Effect.provide(NodeFs))
  );

  expect(Option.getOrThrow(ticket).id).toBe('folder:7');
  expect(Option.getOrThrow(ticket).body).toBe(body);
});

test('getOneBy yields no ticket when the folder is missing', async () => {
  const ticket = await Effect.runPromise(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const dir = yield* setup([]);
      return yield* getOneIn(path.join(dir, 'does-not-exist'));
    }).pipe(Effect.provide(NodeFs))
  );

  expect(Option.isNone(ticket)).toBe(true);
});

test('save writes the front matter back and keeps the body', async () => {
  const escalated = Ticket.create({
    id: formatTicketId('folder', '5'),
    title: 'Save me',
    project: 'demo',
    kind: 'task',
    hitl: 'yes',
    status: 'ready-for-agent',
    blockedBy: [],
    blocks: [],
    body: '',
  });

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* setup([
        [
          '5.md',
          frontMatter({
            id: 5,
            title: 'Save me',
            project: 'demo',
            kind: 'implementation',
            status: 'ready-for-agent',
            blockedBy: [],
            blocks: [],
          }) + '# Save me\n\nOriginal body text.\n',
        ],
      ]);

      yield* TicketSource.pipe(
        Effect.flatMap((source) => source.save(escalated)),
        Effect.provide(withDir(dir))
      );

      const content = yield* fs.readFileString(path.join(dir, '5.md'));
      const reread = yield* getOneIn(dir);
      return { content, reread };
    }).pipe(Effect.provide(NodeFs))
  );

  expect(result.content).toContain('Original body text.');
  expect(result.content).toContain('kind: task');
  expect(result.content).toContain('hitl: yes');
  expect(Option.getOrThrow(result.reread).kind).toBe('task');
  expect(Option.getOrThrow(result.reread).hitl).toBe('yes');
  expect(Option.getOrThrow(result.reread).body).toContain('Original body text.');
});

test('save places a done ticket in the done subfolder and removes the original', async () => {
  const done = Ticket.create({
    id: formatTicketId('folder', '5'),
    title: 'Save me',
    project: 'demo',
    kind: 'implementation',
    status: 'ready-for-agent',
    blockedBy: [],
    blocks: [],
    body: '',
  }).done();

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* setup([
        [
          '5.md',
          frontMatter({
            id: 5,
            title: 'Save me',
            project: 'demo',
            kind: 'implementation',
            status: 'claimed',
            claimedBy: 'runner-1',
            blockedBy: [],
            blocks: [],
          }) + '# Save me\n\nOriginal body text.\n',
        ],
      ]);

      yield* TicketSource.pipe(
        Effect.flatMap((source) => source.save(done)),
        Effect.provide(withDir(dir))
      );

      const originalExists = yield* fs.exists(path.join(dir, '5.md'));
      const content = yield* fs.readFileString(path.join(dir, 'done', '5.md'));
      return { originalExists, content };
    }).pipe(Effect.provide(NodeFs))
  );

  expect(result.originalExists).toBe(false);
  expect(result.content).toContain('Original body text.');
  expect(result.content).toContain('status: done');
});

test('save writes a new file with the ticket body and getOneBy fills it only on return', async () => {
  const created = Ticket.create({
    id: formatTicketId('folder', '8'),
    title: 'New file',
    project: 'demo',
    kind: 'implementation',
    status: 'ready-for-agent',
    blockedBy: [],
    blocks: [],
    body: 'Lorem ipsum dolor sit amet.',
  });

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* setup([]);
      yield* TicketSource.pipe(
        Effect.flatMap((source) => source.save(created)),
        Effect.provide(withDir(dir))
      );
      const content = yield* fs.readFileString(path.join(dir, '8.md'));
      const reread = yield* getOneIn(dir);
      return { content, reread };
    }).pipe(Effect.provide(NodeFs))
  );

  expect(result.content).toContain('Lorem ipsum dolor sit amet.');
  expect(Option.getOrThrow(result.reread).body).toBe('Lorem ipsum dolor sit amet.');
});

test('save round-trips a ticket that omits project', async () => {
  const created = Ticket.create({
    id: formatTicketId('folder', '8'),
    title: 'No project',
    kind: 'implementation',
    status: 'ready-for-agent',
    blockedBy: [],
    blocks: [],
    body: '',
  });

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* setup([]);
      yield* TicketSource.pipe(
        Effect.flatMap((source) => source.save(created)),
        Effect.provide(withDir(dir))
      );
      const content = yield* fs.readFileString(path.join(dir, '8.md'));
      const reread = yield* getOneIn(dir);
      return { content, reread };
    }).pipe(Effect.provide(NodeFs))
  );

  expect(result.content).not.toContain('project:');
  expect(Option.getOrThrow(result.reread).project).toBeUndefined();
});

test('getManyBy scopes to the project and returns an empty array when none match', async () => {
  const common = { kind: 'implementation', blocks: [], blockedBy: [] };
  const tickets = await Effect.runPromise(
    Effect.gen(function* () {
      const dir = yield* setup([
        ['1.md', frontMatter({ id: 1, title: 'other project', project: 'other', status: 'claimed', claimedBy: 'runner-1', ...common })],
      ]);
      return yield* getManyIn(dir, TicketQuery.byProject('wanted' as never).build());
    }).pipe(Effect.provide(NodeFs))
  );

  expect(tickets).toEqual([]);
});

test('getOneBy by identity fills the body of the returned ticket only', async () => {
  const common = { project: 'demo', kind: 'implementation', status: 'ready-for-agent', blocks: [] };
  const ticket = await Effect.runPromise(
    Effect.gen(function* () {
      const dir = yield* setup([
        ['1.md', frontMatter({ id: 1, title: 'other', blockedBy: [], ...common }) + 'Skipped body.\n'],
        ['2.md', frontMatter({ id: 2, title: 'wanted', blockedBy: [], ...common }) + 'Returned body.\n'],
      ]);
      return yield* getOneIn(dir, TicketQuery.byId(formatTicketId('folder', '2')).build());
    }).pipe(Effect.provide(NodeFs))
  );

  expect(Option.getOrThrow(ticket).id).toBe('folder:2');
  expect(Option.getOrThrow(ticket).body).toBe('Returned body.\n');
});

const reportIn = (dir: string, event: TicketEvent) =>
  TicketSource.pipe(
    Effect.flatMap((source) => source.report(formatTicketId('folder', '1'), event)),
    Effect.provide(withDir(dir))
  );

test('after claimed and after released the ticket file is byte-for-byte unchanged', async () => {
  const content =
    frontMatter({ id: 1, title: 'reported', project: 'demo', kind: 'implementation', status: 'ready-for-agent', blockedBy: [], blocks: [] }) +
    '# Reported\n\n- [ ] Keep me.\n';
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* setup([['1-reported.md', content]]);
      yield* reportIn(dir, 'claimed');
      const afterClaimed = yield* fs.readFileString(path.join(dir, '1-reported.md'));
      yield* reportIn(dir, 'released');
      const afterReleased = yield* fs.readFileString(path.join(dir, '1-reported.md'));
      const files = yield* fs.readDirectory(dir);
      return { afterClaimed, afterReleased, files };
    }).pipe(Effect.provide(NodeFs))
  );

  expect(result.afterClaimed).toBe(content);
  expect(result.afterReleased).toBe(content);
  expect(result.files).toEqual(['1-reported.md']);
});

test('after escalated and retried the ticket file is byte-for-byte unchanged', async () => {
  const content =
    frontMatter({ id: 1, title: 'escalated', project: 'demo', kind: 'implementation', status: 'ready-for-agent', blockedBy: [], blocks: [] }) +
    '# Escalated\n\n- [x] Keep me.\n';
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* setup([['1-escalated.md', content]]);
      yield* reportIn(dir, 'escalated');
      const afterEscalated = yield* fs.readFileString(path.join(dir, '1-escalated.md'));
      yield* reportIn(dir, 'retried');
      const afterRetried = yield* fs.readFileString(path.join(dir, '1-escalated.md'));
      const files = yield* fs.readDirectory(dir);
      return { afterEscalated, afterRetried, files };
    }).pipe(Effect.provide(NodeFs))
  );

  expect(result.afterEscalated).toBe(content);
  expect(result.afterRetried).toBe(content);
  expect(result.files).toEqual(['1-escalated.md']);
});

test('a file with claimedBy or a claim status is read and those values are ignored', async () => {
  const common = { project: 'demo', kind: 'implementation', blocks: [], blockedBy: [] };
  const tickets = await Effect.runPromise(
    Effect.gen(function* () {
      const dir = yield* setup([
        ['1-claiming.md', frontMatter({ id: 1, title: 'claiming', status: 'claiming', ...common })],
        ['2-claimed.md', frontMatter({ id: 2, title: 'claimed', status: 'claimed', claimedBy: 'runner-1', ...common })],
        ['3-ready.md', frontMatter({ id: 3, title: 'ready', status: 'ready-for-agent', claimedBy: 'runner-2', ...common })],
      ]);
      return yield* getManyIn(dir);
    }).pipe(Effect.provide(NodeFs))
  );

  expect(tickets.map((ticket) => [ticket.id, ticket.status])).toEqual([
    ['folder:1', 'ready-for-agent'],
    ['folder:2', 'ready-for-agent'],
    ['folder:3', 'ready-for-agent'],
  ]);
  expect(tickets.some((ticket) => 'claimedBy' in ticket)).toBe(false);
});

test('getManyBy reads the tickets that the generator wrote', async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const dir = yield* setup([]);
      yield* generateTickets({ count: 4, kinds: [], statuses: [], hitls: [], projects: [], chain: true }).pipe(
        Effect.provide(fixtureWriterFolderLive(dir))
      );
      const tickets = yield* getManyIn(dir);
      const second = yield* getOneIn(dir, TicketQuery.byId(formatTicketId('folder', '2')).build());
      return { tickets, second };
    }).pipe(Effect.provide(NodeFs))
  );

  expect(
    result.tickets.map((ticket) => ({
      id: ticket.id,
      title: ticket.title,
      project: ticket.project,
      status: ticket.status,
      kind: ticket.kind,
      hitl: ticket.hitl,
      blockedBy: [...ticket.blockedBy],
      blocks: [...ticket.blocks],
    }))
  ).toEqual([
    {
      id: 'folder:1',
      title: 'Generated ticket 1',
      project: 'generated',
      status: 'open',
      kind: 'implementation',
      hitl: 'no',
      blockedBy: [],
      blocks: ['folder:2'],
    },
    {
      id: 'folder:2',
      title: 'Generated ticket 2',
      project: 'generated',
      status: 'ready-for-agent',
      kind: 'research',
      hitl: 'no',
      blockedBy: ['folder:1'],
      blocks: ['folder:3'],
    },
    {
      id: 'folder:4',
      title: 'Generated ticket 4',
      project: 'generated',
      status: 'resolved',
      kind: 'grilling',
      hitl: 'yes',
      blockedBy: ['folder:3'],
      blocks: [],
    },
    {
      id: 'folder:3',
      title: 'Generated ticket 3',
      project: 'generated',
      status: 'done',
      kind: 'prototype',
      hitl: 'yes',
      blockedBy: ['folder:2'],
      blocks: ['folder:4'],
    },
  ]);
  expect(Option.map(result.second, (ticket) => ticket.body)).toEqual(Option.some('What is 2 + 2?'));
});
