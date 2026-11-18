import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { Effect, FileSystem, Layer } from 'effect';
import { expect, test } from 'vitest';

import { formatTicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';
import { type Fixture, FixtureWriter } from '~/Core/Tickets/Ports/FixtureWriter';

import { fixtureWriterFolderLive } from './folder';

const NodeFs = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

const ticket = (status: 'open' | 'done'): Fixture => ({
  id: formatTicketId('folder', '1'),
  title: 'Fixture',
  project: 'generated',
  status,
  kind: 'research',
  hitl: 'no',
  blockedBy: [],
  blocks: [],
  body: 'Body.',
});

test('a done fixture replaces the open fixture of the same number', async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectory({ prefix: 'rippls-fixtures-' });
      const write = (tickets: readonly Fixture[]) =>
        FixtureWriter.pipe(
          Effect.flatMap((writer) => writer.write(tickets)),
          Effect.provide(fixtureWriterFolderLive(dir))
        );
      yield* write([ticket('open')]);
      const afterOpen = yield* fs.readDirectory(dir, { recursive: true });
      yield* write([ticket('done')]);
      const afterDone = yield* fs.readDirectory(dir, { recursive: true });
      return { afterOpen: afterOpen.toSorted(), afterDone: afterDone.toSorted() };
    }).pipe(Effect.provide(NodeFs))
  );

  expect(result.afterOpen).toEqual(['1.md']);
  expect(result.afterDone).toEqual(['done', 'done/1.md']);
});

test('the writer fails with FixtureNotWritten when the folder is missing', async () => {
  const error = await Effect.runPromise(
    FixtureWriter.pipe(
      Effect.flatMap((writer) => writer.write([ticket('open')])),
      Effect.flip,
      Effect.provide(fixtureWriterFolderLive('/nonexistent/rippls-fixtures').pipe(Layer.provide(NodeFs)))
    )
  );

  expect(error._tag).toBe('FixtureNotWritten');
});
