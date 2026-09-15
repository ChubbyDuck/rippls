import { ConfigProvider, Effect, Layer } from 'effect';

import { engineConfigProvider } from '~/Core/Shared/Domain/EngineConfig';
import { RepositoryRoot } from '~/Core/Shared/Domain/RepositoryRoot';

import { loadEngineFileConfig } from './load';

export const EngineFileConfigLive = Layer.unwrap(
  Effect.gen(function* () {
    const root = yield* RepositoryRoot;
    const fileConfig = yield* loadEngineFileConfig(root);
    return ConfigProvider.layer(engineConfigProvider(fileConfig));
  })
);
