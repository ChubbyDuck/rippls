import { type Config, ConfigProvider, type FileSystem, Layer, type Path } from 'effect';
import type { ChildProcessSpawner } from 'effect/unstable/process';

import type { LinearSourceConfig, LocatedFolderSource, LocatedTicketSource } from '~/Core/Shared/Domain/EngineConfig';
import type { RepositoryRoot } from '~/Core/Shared/Domain/RepositoryRoot';
import { defaultTicketKind, type TicketKind } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketKind';
import type { LinearApi } from '~/Core/Tickets/Ports/LinearApi';
import type { TicketSource } from '~/Core/Tickets/Ports/TicketSource';
import { LinearApiLive } from '~/Infrastructure/Tickets/LinearApi/live';

import { TicketSourceFolderLive } from './folder';
import { TicketSourceLinearLive } from './linear';

/** What the folder Source needs: the files, Git, and the Repository Root its Ticket Worktrees belong to. */
type FolderServices =
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
  | RepositoryRoot;

const linearConfig = (source: LinearSourceConfig, defaultKind: TicketKind) =>
  ConfigProvider.layer(
    ConfigProvider.fromUnknown({
      teamId: source.teamId,
      apiKeyEnv: source.apiKeyEnv ?? 'LINEAR_API_KEY',
      defaultKind,
    })
  );

const folderConfig = (source: LocatedFolderSource, defaultKind: TicketKind) =>
  ConfigProvider.layer(
    ConfigProvider.fromUnknown({
      ticketsDir: source.ticketsDir,
      defaultKind,
      ...(source.defaultHitl === undefined ? {} : { defaultHitl: source.defaultHitl }),
    })
  );

export function ticketSourceLive(
  source: LocatedFolderSource,
  defaultKind?: TicketKind
): Layer.Layer<TicketSource, Config.ConfigError, FolderServices>;
export function ticketSourceLive(
  source: LinearSourceConfig,
  defaultKind?: TicketKind
): Layer.Layer<TicketSource, Config.ConfigError, LinearApi>;
export function ticketSourceLive(
  source: LocatedTicketSource,
  defaultKind?: TicketKind
): Layer.Layer<TicketSource, Config.ConfigError, LinearApi | FolderServices>;
export function ticketSourceLive(source: LocatedTicketSource, defaultKind: TicketKind = defaultTicketKind) {
  return source._tag === 'linear'
    ? TicketSourceLinearLive.pipe(Layer.provide(linearConfig(source, defaultKind)))
    : TicketSourceFolderLive.pipe(Layer.provide(folderConfig(source, defaultKind)));
}

export const liveTicketSource = (
  source: LocatedTicketSource,
  defaultKind: TicketKind = defaultTicketKind
): Layer.Layer<TicketSource, Config.ConfigError, FolderServices> =>
  source._tag === 'linear'
    ? (TicketSourceLinearLive.pipe(
        Layer.provide(LinearApiLive),
        Layer.provide(linearConfig(source, defaultKind))
      ) as Layer.Layer<TicketSource, Config.ConfigError, FolderServices>)
    : ticketSourceLive(source, defaultKind);
