import * as NodeServices from '@effect/platform-node/NodeServices';
import { ConfigProvider, Effect, FileSystem, Layer, Option, Path } from 'effect';
import { expect, test } from 'vitest';

import { RepositoryRoot } from '~/Core/Shared/Domain/RepositoryRoot';
import { Ticket } from '~/Core/Tickets/Domain/Entities/Ticket/entity';
import { formatTicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';
import type { ReportedEvent } from '~/Core/Tickets/Domain/Events/TicketEvent';
import { TicketQuery } from '~/Core/Tickets/Domain/Queries/TicketQuery';
import { doneInSourceIds, isUnblocked } from '~/Core/Tickets/Domain/Services/eligibility';
import { generateTickets } from '~/Core/Tickets/Application/UseCases/Generate/generate';
import { fixtureWriterFolderLive } from '~/Infrastructure/Tickets/FixtureWriter/folder';
import { TicketSource } from '~/Core/Tickets/Ports/TicketSource';

import { TicketSourceFolderLive } from './folder';

const NodeFs = NodeServices.layer;

// These tickets folders are not in a Git repository: the Repository Root lies
// elsewhere, so no Ticket Worktree holds their files.
const outsideRoot = '/rippls-test-repository-root';
const outsideWorktree = { path: `${outsideRoot}/.sandcastle/worktrees/ticket-folder-1`, branch: 'ticket-folder-1' };

const frontMatter = (fields: Record<string, unknown>): string => {
  const lines = Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
  return `---\n${lines.join('\n')}\n---\n`;
};

type Fallbacks = { readonly defaultKind?: string; readonly defaultHitl?: string };

const withDir = (folder: string, fallbacks: Fallbacks = {}) =>
  TicketSourceFolderLive.pipe(
    Layer.provide(
      Layer.merge(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({ harnesses: [{ name: 'Cursor' }], ticketsDir: folder, ...fallbacks })
        ),
        Layer.succeed(RepositoryRoot, outsideRoot)
      )
    )
  );

const setup = (files: ReadonlyArray<readonly [string, string]>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectory({ prefix: 'engine-tickets-' });
    yield* Effect.forEach(files, ([name, content]) =>
      fs
        .makeDirectory(path.dirname(path.join(dir, name)), { recursive: true })
        .pipe(Effect.andThen(fs.writeFileString(path.join(dir, name), content)))
    );
    return dir;
  });

const getOneIn = (dir: string, query = TicketQuery.build()) =>
  TicketSource.pipe(
    Effect.flatMap((source) => source.getOneBy(query)),
    Effect.option,
    Effect.provide(withDir(dir))
  );

const getManyIn = (dir: string, query = TicketQuery.build(), fallbacks: Fallbacks = {}) =>
  TicketSource.pipe(
    Effect.flatMap((source) => source.getManyBy(query)),
    Effect.provide(withDir(dir, fallbacks))
  );

// Reads every file of a fresh tickets folder, by identity.
const readAll = (files: ReadonlyArray<readonly [string, string]>, fallbacks: Fallbacks = {}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const dir = yield* setup(files);
      const tickets = yield* getManyIn(dir, TicketQuery.build(), fallbacks);
      return new Map(tickets.map((ticket) => [ticket.id, ticket]));
    }).pipe(Effect.provide(NodeFs))
  );

const folderId = (value: number) => formatTicketId('folder', String(value));

test('folder source namespaces ids in memory and leaves the numbers on disk', async () => {
  const content =
    frontMatter({
      id: 6,
      title: 'Namespaced',
      project: 'demo',
      kind: 'implementation',
      status: 'ready-for-agent',
      blockedBy: [5],
      blocks: [],
    }) + 'Keep the body.\n';

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* setup([['6.md', content]]);
      const ticket = yield* getOneIn(dir);
      const after = yield* fs.readFileString(path.join(dir, '6.md'));
      return { ticket, after };
    }).pipe(Effect.provide(NodeFs))
  );

  expect(Option.getOrThrow(result.ticket).id).toBe('folder:6');
  expect(Option.getOrThrow(result.ticket).blockedBy).toEqual(['folder:5']);
  expect(result.after).toBe(content);
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

test('getOneBy skips unreadable files and non-md files', async () => {
  const ticket = await Effect.runPromise(
    Effect.gen(function* () {
      const dir = yield* setup([
        ['1.md', '---\ntitle: [unclosed\n---\nBody.\n'],
        ['2.md', frontMatter({ title: 'Invalid Kind', kind: 'chore', status: 'ready-for-agent' })],
        ['3.md', '---\ntitle: No closing delimiter\n'],
        ['4.txt', frontMatter({ title: 'x', kind: 'task', hitl: 'no' })],
        ['5.md', frontMatter({ title: 'Valid ticket', kind: 'implementation' })],
      ]);
      return yield* getOneIn(dir);
    }).pipe(Effect.provide(NodeFs))
  );

  expect(Option.getOrThrow(ticket).id).toBe('folder:5');
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

test('done leaves its dependent byte for byte unchanged, and the dependent reads its blocker as done from done/', async () => {
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
      yield* TicketSource.pipe(
        Effect.flatMap((source) => source.reportDone(formatTicketId('folder', '1'), outsideWorktree)),
        Effect.flatMap((afterMerge) => afterMerge),
        Effect.provide(withDir(dir))
      );
      const after = yield* fs.readFileString(path.join(dir, '2-dependent.md'));
      const tickets = yield* getManyIn(dir, TicketQuery.build());
      return { after, tickets };
    }).pipe(Effect.provide(NodeFs))
  );

  expect(result.after).toBe(dependent);
  expect(result.tickets.map((ticket) => [ticket.id, ticket.doneInSource])).toEqual([
    ['folder:2', false],
    ['folder:1', true],
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

  expect(tickets.map((ticket) => [ticket.id, ticket.doneInSource])).toEqual([
    ['folder:3', false],
    ['folder:1', true],
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

test('getOneBy reads the whole body of a file with a large body', async () => {
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

const reportIn = (dir: string, event: ReportedEvent) =>
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
  const common = { project: 'demo', kind: 'task', blocks: [], blockedBy: [] };
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

  // A claim status is not a marker, so a stated task with no other signal is HITL yes.
  expect(tickets.map((ticket) => [ticket.id, ticket.hitl])).toEqual([
    ['folder:1', 'yes'],
    ['folder:2', 'yes'],
    ['folder:3', 'no'],
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
      kind: ticket.kind,
      hitl: ticket.hitl,
      blockedBy: [...ticket.blockedBy],
      doneInSource: ticket.doneInSource,
    }))
  ).toEqual([
    {
      id: 'folder:1',
      title: 'Generated ticket 1',
      project: 'generated',
      kind: 'implementation',
      hitl: 'no',
      blockedBy: [],
      doneInSource: false,
    },
    {
      id: 'folder:2',
      title: 'Generated ticket 2',
      project: 'generated',
      kind: 'research',
      hitl: 'no',
      blockedBy: ['folder:1'],
      doneInSource: false,
    },
    {
      id: 'folder:4',
      title: 'Generated ticket 4',
      project: 'generated',
      kind: 'grilling',
      hitl: 'yes',
      blockedBy: ['folder:3'],
      doneInSource: false,
    },
    {
      id: 'folder:3',
      title: 'Generated ticket 3',
      project: 'generated',
      kind: 'prototype',
      hitl: 'yes',
      blockedBy: ['folder:2'],
      doneInSource: true,
    },
  ]);
  expect(Option.map(result.second, (ticket) => ticket.body)).toEqual(Option.some('What is 2 + 2?'));
});

const currentTicket =
  frontMatter({
    id: 1,
    title: 'Add a health endpoint',
    project: 'health',
    status: 'ready-for-agent',
    kind: 'implementation',
    blockedBy: [],
    blocks: [2],
  }) + '\nAdd `GET /health`.\n';

const standardTemplate = [
  '# 02: Document the health endpoint',
  '',
  '**What to build:** a section in the guide for `GET /health`.',
  '',
  '**Blocked by:** 01',
  '',
  '**Status:** ready-for-agent',
  '',
  '- [ ] The guide shows the endpoint.',
  '',
].join('\n');

const bareNote = 'Rename `createClient` to `makeClient` everywhere.\n';

test('the folder Source reads a front matter ticket, a ticket in the standard template, and a bare note', async () => {
  const tickets = await readAll([
    ['1-add-health.md', currentTicket],
    ['02-document-health.md', standardTemplate],
    ['3-rename-client.md', bareNote],
  ]);

  expect([...tickets.values()]).toEqual([
    Ticket.create({
      id: folderId(1),
      title: 'Add a health endpoint',
      project: 'health',
      kind: 'implementation',
      hitl: 'no',
      body: 'Add `GET /health`.\n',
    }),
    Ticket.create({
      id: folderId(2),
      title: 'Document the health endpoint',
      kind: 'implementation',
      hitl: 'no',
      blockedBy: [folderId(1)],
      body: standardTemplate,
    }),
    Ticket.create({
      id: folderId(3),
      title: 'rename-client',
      kind: 'implementation',
      hitl: 'yes',
      body: bareNote,
    }),
  ]);
});

test('the Title comes from the title field, then the first heading, then the filename', async () => {
  const tickets = await readAll([
    ['1-from-the-filename.md', frontMatter({ title: 'From the field' }) + '# From the heading\n'],
    ['2-from-the-filename.md', 'Some text first.\n\n## 2 — From the heading\n\n# A later heading\n'],
    ['3-from-the-filename.md', '```md\n# Not a heading\n```\nNo heading here.\n'],
    ['4_from_the_filename.md', '#hashtag is no heading.\n'],
    ['5.md', 'A note without a name.\n'],
    ['6-from-the-filename.md', '# 6 — \n'],
  ]);

  expect([...tickets.values()].map((ticket) => ticket.title)).toEqual([
    'From the field',
    'From the heading',
    'from-the-filename',
    'from_the_filename',
    '5',
    'from-the-filename',
  ]);
});

test('a heading keeps a number that no separator follows', async () => {
  const tickets = await readAll([['1-note.md', '# 2024 roadmap\n']]);

  expect(tickets.get(folderId(1))?.title).toBe('2024 roadmap');
});

test('HITL comes from a hitl field, then a marker, then a stated Ticket Kind, and is yes otherwise', async () => {
  const tickets = await readAll([
    ['1.md', frontMatter({ hitl: 'yes', status: 'ready-for-agent', kind: 'implementation' })],
    ['2.md', frontMatter({ status: 'ready-for-human', kind: 'implementation' })],
    ['3.md', frontMatter({ status: 'ready-for-agent', kind: 'grilling' })],
    ['4.md', '# Marker in the body\n\nStatus: `ready-for-human`\n'],
    ['5.md', frontMatter({ kind: 'implementation' })],
    ['6.md', frontMatter({ kind: 'prototype' })],
    ['7.md', frontMatter({ kind: 'task' })],
    ['8.md', 'A bare note.\n'],
    ['9.md', frontMatter({ status: 'open', kind: 'implementation' }) + '**Status:** ready-for-human\n'],
  ]);

  expect([...tickets.values()].map((ticket) => [ticket.id, ticket.hitl])).toEqual([
    [folderId(1), 'yes'],
    [folderId(2), 'yes'],
    [folderId(3), 'no'],
    [folderId(4), 'yes'],
    [folderId(5), 'no'],
    [folderId(6), 'yes'],
    [folderId(7), 'yes'],
    [folderId(8), 'yes'],
    [folderId(9), 'yes'],
  ]);
});

test('a marker in a status field wins over a Status line in the body', async () => {
  const tickets = await readAll([['1.md', frontMatter({ status: 'ready-for-agent' }) + 'Status: ready-for-human\n']]);

  expect(tickets.get(folderId(1))?.hitl).toBe('no');
});

test('a Marker is read in any case, in a status field and in a Status line', async () => {
  const tickets = await readAll([
    ['1.md', frontMatter({ status: 'Ready-For-Agent' })],
    ['2.md', 'STATUS: READY-FOR-AGENT\n'],
  ]);

  expect([...tickets.values()].map((ticket) => ticket.hitl)).toEqual(['no', 'no']);
});

test('the default Ticket Kind implies no HITL, and the config changes the default and the fallback', async () => {
  const files = [['1.md', 'A bare note.\n'], ['2.md', frontMatter({ kind: 'grilling' })]] as const;

  const standard = await readAll(files);
  const ready = await readAll(files, { defaultKind: 'research', defaultHitl: 'no' });

  expect([...standard.values()].map((ticket) => [ticket.kind, ticket.hitl])).toEqual([
    ['implementation', 'yes'],
    ['grilling', 'yes'],
  ]);
  expect([...ready.values()].map((ticket) => [ticket.kind, ticket.hitl])).toEqual([
    ['research', 'no'],
    ['grilling', 'yes'],
  ]);
});

test('an existing ticket with status open or blocked and a stated implementation Kind is Unattended', async () => {
  const common = { project: 'demo', kind: 'implementation', blocks: [] };
  const tickets = await readAll([
    ['1.md', frontMatter({ id: 1, title: 'open', status: 'open', blockedBy: [], ...common })],
    ['2.md', frontMatter({ id: 2, title: 'blocked', status: 'blocked', blockedBy: [1], ...common })],
  ]);

  expect([...tickets.values()].map((ticket) => [ticket.id, ticket.hitl])).toEqual([
    [folderId(1), 'no'],
    [folderId(2), 'no'],
  ]);
});

test('a ticket with an empty claimedBy key is read', async () => {
  const tickets = await readAll([
    ['1.md', '---\ntitle: Claimed once\nkind: implementation\nclaimedBy:\nblocks:\n  - 2\nowner: someone\n---\nBody.\n'],
  ]);

  expect(tickets.get(folderId(1))?.title).toBe('Claimed once');
  expect(tickets.get(folderId(1))?.hitl).toBe('no');
});

test('empty front matter and a key with no value state nothing', async () => {
  const tickets = await readAll([
    ['1.md', '---\n---\n# Empty front matter\n'],
    ['2.md', '---\ntitle:\nproject:\nblockedBy:\n---\n# Empty keys\n'],
  ]);

  expect([...tickets.values()].map((ticket) => [ticket.title, ticket.project, ticket.blockedBy])).toEqual([
    ['Empty front matter', undefined, []],
    ['Empty keys', undefined, []],
  ]);
});

test('a file with unparseable front matter, or an invalid value for a known hint, is not taken', async () => {
  const tickets = await readAll([
    ['1.md', '---\ntitle: [unclosed\n---\n'],
    ['2.md', frontMatter({ title: 'Invalid Kind', kind: 'chore' })],
    ['3.md', frontMatter({ title: 'Invalid HITL', hitl: 'maybe' })],
    ['4.md', frontMatter({ title: 'Invalid blockers', blockedBy: 'two' })],
    ['5.md', '---\n- a list\n---\n'],
    ['6.md', frontMatter({ title: 'Readable' })],
  ]);

  expect([...tickets.keys()]).toEqual([folderId(6)]);
});

test('a "Blocked by" line names blockers by number, ignores the text after each number, and reads none as no blockers', async () => {
  const tickets = await readAll([
    ['1.md', '# One number\n\n**Blocked by:** 7\n'],
    ['2.md', '# Titles\n\n**Blocked by:** 02 (Unblocked is derived from done), 010 (A ticket needs only an identity and text).\n'],
    ['3.md', '# None\n\n**Blocked by:** none\n'],
    ['4.md', '# None with a remark\n\n**Blocked by:** None (can start immediately)\n'],
    ['5.md', '# Plain\n\n- Blocked by: 3, 4\n'],
  ]);

  expect([...tickets.values()].map((ticket) => [ticket.id, ticket.blockedBy])).toEqual([
    [folderId(1), [folderId(7)]],
    [folderId(2), [folderId(2), folderId(10)]],
    [folderId(3), []],
    [folderId(4), []],
    [folderId(5), [folderId(3), folderId(4)]],
  ]);
});

test('a number inside the parentheses of another item is not read as a blocker', async () => {
  const tickets = await readAll([['1.md', '**Blocked by:** 2 (after 5, then 6), 3 (see 4)\n']]);

  expect(tickets.get(folderId(1))?.blockedBy).toEqual([folderId(2), folderId(3)]);
});

test('an item without a leading number, a number with no ticket, or an empty line keeps the ticket blocked', async () => {
  const tickets = await readAll([
    ['done/1-first.md', '# First\n'],
    ['2.md', '**Blocked by:** 01 (First)\n'],
    ['3.md', '**Blocked by:** 01 (First), First\n'],
    ['4.md', '**Blocked by:** 99\n'],
    ['5.md', '**Blocked by:**\n\n- 01 (First)\n'],
  ]);
  const done = doneInSourceIds([...tickets.values()]);

  expect([2, 3, 4, 5].map((value) => isUnblocked(tickets.get(folderId(value))!, done))).toEqual([
    true,
    false,
    false,
    false,
  ]);
});

test('the blockedBy field wins over a "Blocked by" line', async () => {
  const tickets = await readAll([
    ['1.md', frontMatter({ blockedBy: [2] }) + '**Blocked by:** 3\n'],
    ['2.md', frontMatter({ blockedBy: [] }) + '**Blocked by:** 3\n'],
    ['3.md', '---\nblockedBy:\n---\n**Blocked by:** 4\n'],
  ]);

  expect([...tickets.values()].map((ticket) => ticket.blockedBy)).toEqual([[folderId(2)], [], [folderId(4)]]);
});
