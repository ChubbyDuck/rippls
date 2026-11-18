import { type Config, ConfigProvider, type FileSystem, Layer, type Path } from 'effect';
import type { ChildProcessSpawner } from 'effect/unstable/process';

import type { TicketSourceConfig } from '~/Core/Shared/Domain/EngineConfig';
import type { RepositoryRoot } from '~/Core/Shared/Domain/RepositoryRoot';
import type { LinearApi } from '~/Core/Tickets/Ports/LinearApi';
import type { TicketSource } from '~/Core/Tickets/Ports/TicketSource';
import { LinearApiLive } from '~/Infrastructure/Tickets/LinearApi/live';

import { TicketSourceFolderLive } from './folder';
import { TicketSourceLinearLive } from './linear';

type FolderSource = Extract<TicketSourceConfig, { readonly _tag: 'folder' }>;
type LinearSource = Extract<TicketSourceConfig, { readonly _tag: 'linear' }>;

/** What the folder Source needs: the files, Git, and the Repository Root its Ticket Worktrees belong to. */
type FolderServices =
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
  | RepositoryRoot;

const linearConfig = (source: LinearSource) =>
  ConfigProvider.layer(
    ConfigProvider.fromUnknown({
      teamId: source.teamId,
      apiKeyEnv: source.apiKeyEnv ?? 'LINEAR_API_KEY',
    })
  );

export function ticketSourceLive(
  source: FolderSource
): Layer.Layer<TicketSource, Config.ConfigError, FolderServices>;
export function ticketSourceLive(
  source: LinearSource
): Layer.Layer<TicketSource, Config.ConfigError, LinearApi>;
export function ticketSourceLive(
  source: TicketSourceConfig
): Layer.Layer<TicketSource, Config.ConfigError, LinearApi | FolderServices>;
export function ticketSourceLive(source: TicketSourceConfig) {
  return source._tag === 'linear'
    ? TicketSourceLinearLive.pipe(Layer.provide(linearConfig(source)))
    : TicketSourceFolderLive.pipe(
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ ticketsDir: source.ticketsDir })))
      );
}

export const liveTicketSource = (
  source: TicketSourceConfig
): Layer.Layer<TicketSource, Config.ConfigError, FolderServices> =>
  source._tag === 'linear'
    ? (TicketSourceLinearLive.pipe(
        Layer.provide(LinearApiLive),
        Layer.provide(linearConfig(source))
      ) as Layer.Layer<TicketSource, Config.ConfigError, FolderServices>)
    : ticketSourceLive(source);
