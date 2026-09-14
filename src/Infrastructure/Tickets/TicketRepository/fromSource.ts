import { type Config, ConfigProvider, type FileSystem, Layer, type Path } from 'effect';

import type { TicketSource } from '~/Core/Shared/Domain/HarnessConfig';
import type { LinearApi } from '~/Core/Tickets/Ports/LinearApi';
import type { TicketRepository } from '~/Core/Tickets/Ports/TicketRepository';
import { LinearApiLive } from '~/Infrastructure/Tickets/LinearApi/live';

import { TicketRepositoryFolderLive } from './folder';
import { TicketRepositoryLinearLive } from './linear';

type FolderSource = Extract<TicketSource, { readonly _tag: 'folder' }>;
type LinearSource = Extract<TicketSource, { readonly _tag: 'linear' }>;

const linearConfig = (source: LinearSource) =>
  ConfigProvider.layer(
    ConfigProvider.fromUnknown({
      teamId: source.teamId,
      apiKeyEnv: source.apiKeyEnv ?? 'LINEAR_API_KEY',
    })
  );

export function ticketRepositoryLive(
  source: FolderSource
): Layer.Layer<TicketRepository, Config.ConfigError, FileSystem.FileSystem | Path.Path>;
export function ticketRepositoryLive(
  source: LinearSource
): Layer.Layer<TicketRepository, Config.ConfigError, LinearApi>;
export function ticketRepositoryLive(
  source: TicketSource
): Layer.Layer<TicketRepository, Config.ConfigError, LinearApi | FileSystem.FileSystem | Path.Path>;
export function ticketRepositoryLive(source: TicketSource) {
  return source._tag === 'linear'
    ? TicketRepositoryLinearLive.pipe(Layer.provide(linearConfig(source)))
    : TicketRepositoryFolderLive.pipe(
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ ticketsDir: source.ticketsDir })))
      );
}

export const liveTicketRepository = (
  source: TicketSource
): Layer.Layer<TicketRepository, Config.ConfigError, FileSystem.FileSystem | Path.Path> =>
  source._tag === 'linear'
    ? (TicketRepositoryLinearLive.pipe(
        Layer.provide(LinearApiLive),
        Layer.provide(linearConfig(source))
      ) as Layer.Layer<TicketRepository, Config.ConfigError, FileSystem.FileSystem | Path.Path>)
    : ticketRepositoryLive(source);
