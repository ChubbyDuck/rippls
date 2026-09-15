import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { ConfigProvider, Effect, FileSystem, Layer, Path } from 'effect';
import { expect, test } from 'vitest';

import { engineConfig, resolveTicketSource } from '~/Core/Shared/Domain/EngineConfig';
import { TicketQuery } from '~/Core/Tickets/Domain/Queries/TicketQuery';
import { LinearApi, type LinearIssue, LinearIssueNotFound } from '~/Core/Tickets/Ports/LinearApi';
import { TicketSource } from '~/Core/Tickets/Ports/TicketSource';

import { ticketSourceLive } from './fromSource';

const NodeFs = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

const folderSource = (ticketsDir: string) =>
  engineConfig.parse(ConfigProvider.fromUnknown({
    harnesses: [{ name: 'Codex' }],
    source: { _tag: 'folder', ticketsDir },
  })).pipe(Effect.flatMap((config) => resolveTicketSource(config.source, 'folder')));

const linearSource = (teamId: string) =>
  engineConfig.parse(ConfigProvider.fromUnknown({
    harnesses: [{ name: 'Codex' }],
    source: { _tag: 'linear', teamId },
  })).pipe(Effect.flatMap((config) => resolveTicketSource(config.source, 'linear')));

test('ticketSourceLive reads from the folder source', async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectory({ prefix: 'engine-source-' });
      yield* fs.writeFileString(
        path.join(dir, '1.md'),
        '---\nid: 1\ntitle: "From folder"\nproject: "demo"\nkind: "implementation"\nstatus: "ready-for-agent"\nblockedBy: []\nblocks: []\n---\n'
      );
      const resolved = yield* folderSource(dir);
      const tickets = yield* TicketSource.pipe(
        Effect.flatMap((source) => source.getManyBy(TicketQuery.build())),
        Effect.provide(ticketSourceLive(resolved))
      );
      return tickets.map((ticket) => ticket.title);
    }).pipe(Effect.provide(NodeFs))
  );

  expect(result).toEqual(['From folder']);
});

const linearIssue: LinearIssue = {
  id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  identifier: 'ENG-1',
  title: 'From linear',
  description: 'Body',
  createdAt: '2026-01-01T00:00:00.000Z',
  assigneeId: null,
  state: { id: 'state-unstarted', name: 'Todo', type: 'unstarted' },
  project: { id: 'proj-1', name: 'Demo', slugId: 'demo' },
  labels: [{ id: 'label-impl', name: 'kind:implementation' }],
  relations: [],
  inverseRelations: [],
};

test('ticketSourceLive reads from the linear source', async () => {
  const api = Layer.succeed(LinearApi, {
    metadata: () =>
      Effect.succeed({
        viewer: { id: 'viewer-1', name: 'Dev' },
        states: [{ id: 'state-unstarted', name: 'Todo', type: 'unstarted' }],
        labels: [{ id: 'label-impl', name: 'kind:implementation' }],
        projects: [{ id: 'proj-1', name: 'Demo', slugId: 'demo' }],
      }),
    issues: () => Effect.succeed([linearIssue]),
    issue: (id) =>
      id === linearIssue.id ? Effect.succeed(linearIssue) : Effect.fail(new LinearIssueNotFound()),
    setState: () => Effect.void,
    setAssignee: () => Effect.void,
    setLabels: () => Effect.void,
    createRelation: () => Effect.void,
    deleteRelation: () => Effect.void,
  });

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const resolved = yield* linearSource('team-1');
      const tickets = yield* TicketSource.pipe(
        Effect.flatMap((source) => source.getManyBy(TicketQuery.build())),
        Effect.provide(ticketSourceLive(resolved).pipe(Layer.provide(api)))
      );
      return tickets.map((ticket) => ticket.title);
    })
  );

  expect(result).toEqual(['From linear']);
});
