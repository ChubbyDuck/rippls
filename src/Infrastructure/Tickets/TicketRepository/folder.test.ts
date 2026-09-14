import { ConfigProvider, Effect, FileSystem, Layer, Option, Path } from 'effect';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { expect, test } from 'vitest';

import { Ticket } from '~/Core/Tickets/Domain/Entities/Ticket/entity';
import { formatTicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';
import { TicketQuery } from '~/Core/Tickets/Domain/Queries/TicketQuery';
import { TicketRepository } from '~/Core/Tickets/Ports/TicketRepository';

import { TicketRepositoryFolderLive } from './folder';

const NodeFs = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

const frontMatter = (fields: Record<string, unknown>): string => {
  const lines = Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
  return `---\n${lines.join('\n')}\n---\n`;
};

const withDir = (folder: string) =>
  TicketRepositoryFolderLive.pipe(
    Layer.provide(
      ConfigProvider.layer(ConfigProvider.fromUnknown({ agents: [{ name: 'Cursor' }], ticketsDir: folder }))
    )
  );

const setup = (files: ReadonlyArray<readonly [string, string]>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectory({ prefix: 'harness-tickets-' });
    yield* Effect.forEach(files, ([name, content]) => fs.writeFileString(path.join(dir, name), content));
    return dir;
  });

const getOneIn = (dir: string, query = TicketQuery.build()) =>
  TicketRepository.pipe(
    Effect.flatMap((repo) => repo.getOneBy(query)),
    Effect.option,
    Effect.provide(withDir(dir))
  );

const getManyIn = (dir: string, query = TicketQuery.build()) =>
  TicketRepository.pipe(
    Effect.flatMap((repo) => repo.getManyBy(query)),
    Effect.provide(withDir(dir))
  );

test('folder source namespaces ids in memory and writes numbers on disk', async () => {
  const claimed = Ticket.create({
    id: formatTicketId('folder', '6'),
    title: 'Namespaced',
    project: 'demo',
    kind: 'implementation',
    status: 'ready-for-agent',
    blockedBy: [formatTicketId('folder', '5')],
    blocks: [],
    body: '',
  }).claim({ by: 'runner-1' as never });

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
      yield* TicketRepository.pipe(
        Effect.flatMap((repo) => repo.save(claimed)),
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
  expect(Option.getOrThrow(result.after).status).toBe('claimed');
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
  const created = Ticket.create({
    id: formatTicketId('folder', '9'),
    title: 'Slugged save',
    project: 'demo',
    kind: 'implementation',
    status: 'ready-for-agent',
    blockedBy: [],
    blocks: [],
    body: '',
  });
  const done = created.claim({ by: 'runner-1' as never }).done();

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

      yield* TicketRepository.pipe(
        Effect.flatMap((repo) => repo.save(created.claim({ by: 'runner-1' as never }))),
        Effect.provide(withDir(dir))
      );
      const claimed = yield* fs.readFileString(path.join(dir, '9-slugged-save.md'));
      const numericExistsAfterClaim = yield* fs.exists(path.join(dir, '9.md'));

      yield* TicketRepository.pipe(
        Effect.flatMap((repo) => repo.save(done)),
        Effect.provide(withDir(dir))
      );
      const originalExists = yield* fs.exists(path.join(dir, '9-slugged-save.md'));
      const doneContent = yield* fs.readFileString(path.join(dir, 'done', '9-slugged-save.md'));
      return { claimed, numericExistsAfterClaim, originalExists, doneContent };
    }).pipe(Effect.provide(NodeFs))
  );

  expect(result.claimed).toContain('status: claimed');
  expect(result.claimed).toContain('Keep this body.');
  expect(result.numericExistsAfterClaim).toBe(false);
  expect(result.originalExists).toBe(false);
  expect(result.doneContent).toContain('status: done');
  expect(result.doneContent).toContain('Keep this body.');
});

test('getOneBy applies the query filters and the id sort', async () => {
  const common = { project: 'demo', kind: 'implementation', status: 'ready-for-agent', blocks: [] };
  const build = (query: TicketQuery) =>
    Effect.gen(function* () {
      const dir = yield* setup([
        ['1.md', frontMatter({ id: 1, title: 'blocked', blockedBy: [9], ...common })],
        ['2.md', frontMatter({ id: 2, title: 'claimed', blockedBy: [], claimedBy: 'runner-1', ...common })],
        ['3.md', frontMatter({ id: 3, title: 'ready low', blockedBy: [], ...common })],
        ['4.md', frontMatter({ id: 4, title: 'ready high', blockedBy: [], ...common })],
      ]);
      return yield* getOneIn(dir, query);
    }).pipe(Effect.provide(NodeFs));

  const ascending = await Effect.runPromise(build(TicketQuery.unblocked().unclaimed().afk().sort('ASC').build()));
  expect(Option.getOrThrow(ascending).id).toBe('folder:3');

  const descending = await Effect.runPromise(build(TicketQuery.unblocked().unclaimed().afk().sort('DESC').build()));
  expect(Option.getOrThrow(descending).id).toBe('folder:4');
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
  const claimed = Ticket.create({
    id: formatTicketId('folder', '5'),
    title: 'Save me',
    project: 'demo',
    kind: 'implementation',
    status: 'ready-for-agent',
    blockedBy: [],
    blocks: [],
    body: '',
  }).claim({ by: 'runner-1' as never });

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

      yield* TicketRepository.pipe(
        Effect.flatMap((repo) => repo.save(claimed)),
        Effect.provide(withDir(dir))
      );

      const content = yield* fs.readFileString(path.join(dir, '5.md'));
      const reread = yield* getOneIn(dir);
      return { content, reread };
    }).pipe(Effect.provide(NodeFs))
  );

  expect(result.content).toContain('Original body text.');
  expect(result.content).toContain('status: claimed');
  expect(Option.getOrThrow(result.reread).status).toBe('claimed');
  expect(Option.getOrThrow(result.reread).claimedBy).toBe('runner-1');
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
  })
    .claim({ by: 'runner-1' as never })
    .done();

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

      yield* TicketRepository.pipe(
        Effect.flatMap((repo) => repo.save(done)),
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
      yield* TicketRepository.pipe(
        Effect.flatMap((repo) => repo.save(created)),
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
      yield* TicketRepository.pipe(
        Effect.flatMap((repo) => repo.save(created)),
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

test('getOneBy skips a claiming ticket when unclaimed is chosen', async () => {
  const common = { project: 'demo', kind: 'implementation', blocks: [], blockedBy: [] };
  const ticket = await Effect.runPromise(
    Effect.gen(function* () {
      const dir = yield* setup([
        ['1.md', frontMatter({ id: 1, title: 'being taken', status: 'claiming', ...common })],
        ['2.md', frontMatter({ id: 2, title: 'ready', status: 'ready-for-agent', ...common })],
      ]);
      return yield* getOneIn(dir, TicketQuery.unclaimed().sort('ASC').build());
    }).pipe(Effect.provide(NodeFs))
  );

  expect(Option.getOrThrow(ticket).id).toBe('folder:2');
});

test('getManyBy returns every claiming and claimed ticket, head only', async () => {
  const common = { project: 'demo', kind: 'implementation', blocks: [], blockedBy: [] };
  const tickets = await Effect.runPromise(
    Effect.gen(function* () {
      const dir = yield* setup([
        ['1.md', frontMatter({ id: 1, title: 'claiming', status: 'claiming', ...common }) + 'Body one.\n'],
        ['2.md', frontMatter({ id: 2, title: 'claimed', status: 'claimed', claimedBy: 'runner-1', ...common }) + 'Body two.\n'],
        ['3.md', frontMatter({ id: 3, title: 'ready', status: 'ready-for-agent', ...common })],
        ['4.md', frontMatter({ id: 4, title: 'done', status: 'done', ...common })],
      ]);
      return yield* getManyIn(dir, TicketQuery.claimed().sort('ASC').build());
    }).pipe(Effect.provide(NodeFs))
  );

  expect(tickets.map((ticket) => ticket.id)).toEqual(['folder:1', 'folder:2']);
  expect(tickets.map((ticket) => ticket.body)).toEqual(['', '']);
});

test('getManyBy scopes to the project and returns an empty array when none match', async () => {
  const common = { kind: 'implementation', blocks: [], blockedBy: [] };
  const tickets = await Effect.runPromise(
    Effect.gen(function* () {
      const dir = yield* setup([
        ['1.md', frontMatter({ id: 1, title: 'other project', project: 'other', status: 'claimed', claimedBy: 'runner-1', ...common })],
      ]);
      return yield* getManyIn(dir, TicketQuery.claimed().byProject('wanted' as never).build());
    }).pipe(Effect.provide(NodeFs))
  );

  expect(tickets).toEqual([]);
});

test('getOneBy fills the body of the returned ticket only', async () => {
  const common = { project: 'demo', kind: 'implementation', status: 'ready-for-agent', blocks: [] };
  const ticket = await Effect.runPromise(
    Effect.gen(function* () {
      const dir = yield* setup([
        ['1.md', frontMatter({ id: 1, title: 'blocked', blockedBy: [9], ...common }) + 'Skipped body.\n'],
        ['2.md', frontMatter({ id: 2, title: 'ready', blockedBy: [], ...common }) + 'Returned body.\n'],
      ]);
      return yield* getOneIn(dir, TicketQuery.unblocked().build());
    }).pipe(Effect.provide(NodeFs))
  );

  expect(Option.getOrThrow(ticket).id).toBe('folder:2');
  expect(Option.getOrThrow(ticket).body).toBe('Returned body.\n');
});
