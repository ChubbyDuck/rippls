import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { Config, Effect, Layer, Option, Schema } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';

import { EngineFileConfigLive } from '~/config/layer';
import {
  EngineConfig,
  engineConfig,
  idleTimeoutConfig,
  pollIntervalConfig,
  resolveTicketSource,
  TicketSourceTag,
} from '~/Core/Shared/Domain/EngineConfig';
import { RepositoryRoot } from '~/Core/Shared/Domain/RepositoryRoot';
import { RepositoryRootLive } from '~/Core/Tickets/Application/UseCases/RunEngine/repositoryRoot';
import { runEngine } from '~/Core/Tickets/Application/UseCases/RunEngine/runEngine';
import { Project } from '~/Core/Tickets/Domain/Entities/Ticket/properties/Project';
import { ConfiguredHarnessesLive } from '~/Infrastructure/Shared/HarnessSelector/configured';
import { makeTracingLayer } from '~/Infrastructure/Shared/Tracing/otlp';
import { StrategySelectorDefault } from '~/Infrastructure/Tickets/StrategySelector/default';
import { liveTicketSource } from '~/Infrastructure/Tickets/TicketSource/fromSource';
import { WorktreeManagerLive } from '~/Infrastructure/Tickets/WorktreeManager/sandcastle';

const TracingLive = Layer.unwrap(
  engineConfig.pipe(Effect.map((config) => makeTracingLayer(Option.fromNullishOr(config.otlpTraceUrl))))
);

const AppLive = Layer.mergeAll(
  StrategySelectorDefault,
  ConfiguredHarnessesLive,
  Layer.unwrap(RepositoryRoot.pipe(Effect.map(WorktreeManagerLive))),
  TracingLive
).pipe(Layer.provideMerge(EngineFileConfigLive), Layer.provideMerge(RepositoryRootLive));

const Concurrency = Schema.Int.check(Schema.isGreaterThan(0));

const command = Command.make(
  'rippls',
  {
    source: Flag.choice('source', TicketSourceTag.literals).pipe(Flag.optional),
    project: Flag.string('project').pipe(Flag.withSchema(Project), Flag.optional),
    limit: Flag.integer('limit').pipe(Flag.optional),
    concurrency: Flag.integer('concurrency').pipe(Flag.withSchema(Concurrency), Flag.withDefault(1)),
    idleTimeout: Flag.string('idle-timeout').pipe(
      Flag.withSchema(Schema.DurationFromString),
      Flag.withFallbackConfig(idleTimeoutConfig)
    ),
    pollInterval: Flag.string('poll-interval').pipe(
      Flag.withSchema(Schema.DurationFromString),
      Flag.withFallbackConfig(pollIntervalConfig)
    ),
  },
  ({ source, project, limit, concurrency, idleTimeout, pollInterval }) =>
    Effect.gen(function* () {
      const config = yield* EngineConfig;
      const resolved = yield* resolveTicketSource(config.source, Option.getOrUndefined(source));
      return yield* runEngine({
        project: Option.getOrUndefined(project),
        limit: Option.getOrUndefined(limit),
        concurrency,
        idleTimeout,
        pollInterval,
      }).pipe(Effect.provide(liveTicketSource(resolved)));
    })
);

export const program = Command.run(command, { version: '0.0.1' }).pipe(
  Effect.provide(AppLive.pipe(Layer.provideMerge(NodeServices.layer)))
);

const describeError = (error: unknown) => (error instanceof Config.ConfigError ? error.cause.message : error);

export const run = () =>
  program.pipe(
    Effect.tapError((error) => Effect.logError(describeError(error))),
    NodeRuntime.runMain({ disableErrorReporting: true })
  );

