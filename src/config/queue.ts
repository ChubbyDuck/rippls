import { Effect, FileSystem, Path } from 'effect';

import {
  type FolderSourceConfig,
  type LocatedFolderSource,
  type LocatedTicketSource,
  type TicketSourceConfig,
  TicketsDir,
} from '~/Core/Shared/Domain/EngineConfig';
import { RepositoryRoot } from '~/Core/Shared/Domain/RepositoryRoot';
import { QueueNotFound } from '~/Core/Tickets/Domain/Exceptions/QueueNotFound';

export const QUEUE_FOLDER = '.agents/tickets';

const isDirectory = (fs: FileSystem.FileSystem, dir: string) =>
  fs.stat(dir).pipe(
    Effect.map((info) => info.type === 'Directory'),
    Effect.orElseSucceed(() => false)
  );

// The nearest queue at or above the start folder, up to the Repository Root and
// never above it. Real paths are compared, so a start folder reached through a
// symbolic link works; a start outside the Repository Root finds no queue.
export const nearestQueue = Effect.fn('config.nearestQueue')(function* (start: string, root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const notFound = new QueueNotFound({ start, root });
  const realStart = yield* fs.realPath(start).pipe(Effect.mapError(() => notFound));
  const realRoot = yield* fs.realPath(root).pipe(Effect.mapError(() => notFound));
  const inRoot = path.relative(realRoot, realStart);
  if (inRoot.startsWith('..') || path.isAbsolute(inRoot)) {
    return yield* notFound;
  }
  for (let dir = realStart; ; dir = path.dirname(dir)) {
    const queue = path.join(dir, QUEUE_FOLDER);
    if (yield* isDirectory(fs, queue)) {
      return TicketsDir.make(queue);
    }
    if (dir === realRoot) {
      return yield* notFound;
    }
  }
});

type QueueServices = FileSystem.FileSystem | Path.Path | RepositoryRoot;

// A folder Source with its queue: a configured tickets folder wins; without one, it
// takes the nearest queue from the start folder.
export const locateFolderQueue = (
  source: FolderSourceConfig,
  start: string
): Effect.Effect<LocatedFolderSource, QueueNotFound, QueueServices> => {
  const { ticketsDir } = source;
  if (ticketsDir !== undefined) {
    return Effect.succeed({ ...source, ticketsDir });
  }
  return RepositoryRoot.pipe(
    Effect.flatMap((root) => nearestQueue(start, root)),
    Effect.map((found) => ({ ...source, ticketsDir: found }))
  );
};

// The Source with its queue. A Linear Source has no folder to look up.
export const locateQueue = (
  source: TicketSourceConfig,
  start: string
): Effect.Effect<LocatedTicketSource, QueueNotFound, QueueServices> =>
  source._tag === 'linear' ? Effect.succeed(source) : locateFolderQueue(source, start);

// The line a run prints at its start, naming the queue it uses.
export const queueLine = (source: LocatedTicketSource): string =>
  source._tag === 'folder' ? `Queue: ${source.ticketsDir}` : `Queue: the Linear team ${source.teamId}`;
