import { type Config, ConfigProvider, type FileSystem, Layer, type Path } from 'effect';

import type { TicketSourceConfig } from '~/Core/Shared/Domain/EngineConfig';
import type { LinearApi } from '~/Core/Tickets/Ports/LinearApi';
import type { TicketSource } from '~/Core/Tickets/Ports/TicketSource';
import { LinearApiLive } from '~/Infrastructure/Tickets/LinearApi/live';

import { TicketSourceFolderLive } from './folder';
import { TicketSourceLinearLive } from './linear';

type FolderSource = Extract<TicketSourceConfig, { readonly _tag: 'folder' }>;
type LinearSource = Extract<TicketSourceConfig, { readonly _tag: 'linear' }>;

const linearConfig = (source: LinearSource) =>
  ConfigProvider.layer(
    ConfigProvider.fromUnknown({
      teamId: source.teamId,
      apiKeyEnv: source.apiKeyEnv ?? 'LINEAR_API_KEY',
    })
  );

export function ticketSourceLive(
  source: FolderSource
): Layer.Layer<TicketSource, Config.ConfigError, FileSystem.FileSystem | Path.Path>;
export function ticketSourceLive(
  source: LinearSource
): Layer.Layer<TicketSource, Config.ConfigError, LinearApi>;
export function ticketSourceLive(
  source: TicketSourceConfig
): Layer.Layer<TicketSource, Config.ConfigError, LinearApi | FileSystem.FileSystem | Path.Path>;
export function ticketSourceLive(source: TicketSourceConfig) {
  return source._tag === 'linear'
    ? TicketSourceLinearLive.pipe(Layer.provide(linearConfig(source)))
    : TicketSourceFolderLive.pipe(
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ ticketsDir: source.ticketsDir })))
      );
}

export const liveTicketSource = (
  source: TicketSourceConfig
): Layer.Layer<TicketSource, Config.ConfigError, FileSystem.FileSystem | Path.Path> =>
  source._tag === 'linear'
    ? (TicketSourceLinearLive.pipe(
        Layer.provide(LinearApiLive),
        Layer.provide(linearConfig(source))
      ) as Layer.Layer<TicketSource, Config.ConfigError, FileSystem.FileSystem | Path.Path>)
    : ticketSourceLive(source);
