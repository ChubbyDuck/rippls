import { homedir } from 'node:os';
import { ConfigProvider, Effect, Layer, Path } from 'effect';

import { engineConfigProvider } from '~/Core/Shared/Domain/EngineConfig';
import { RepositoryRoot } from '~/Core/Shared/Domain/RepositoryRoot';

import { loadEngineFileConfig, userConfigDir } from './load';

export const EngineFileConfigLive = Layer.unwrap(
  Effect.gen(function* () {
    const root = yield* RepositoryRoot;
    const path = yield* Path.Path;
    const fileConfig = yield* loadEngineFileConfig(root, userConfigDir(process.env, homedir(), path));
    return ConfigProvider.layer(engineConfigProvider(fileConfig));
  })
);
