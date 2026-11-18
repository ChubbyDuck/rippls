import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { hostname } from 'node:os';
import { Config, Effect, Layer, Option, Schema } from 'effect';
import { Argument, Command, Flag } from 'effect/unstable/cli';

import { EngineFileConfigLive } from '~/config/layer';
import {
  checkConfig,
  EngineConfig,
  engineConfig,
  idleTimeoutConfig,
  pollIntervalConfig,
  resolveTicketSource,
  TicketSourceTag,
} from '~/Core/Shared/Domain/EngineConfig';
import { RepositoryRoot } from '~/Core/Shared/Domain/RepositoryRoot';
import { retryTicket } from '~/Core/Tickets/Application/UseCases/RetryTicket/retryTicket';
import { retrySourceOf } from '~/Core/Tickets/Application/UseCases/RetryTicket/retrySource';
import { RepositoryRootLive } from '~/Core/Tickets/Application/UseCases/RunEngine/repositoryRoot';
import { runEngine } from '~/Core/Tickets/Application/UseCases/RunEngine/runEngine';
import { showStatus } from '~/Core/Tickets/Application/UseCases/ShowStatus/showStatus';
import { Project } from '~/Core/Tickets/Domain/Entities/Ticket/properties/Project';
import { TicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';
import { TicketNotEscalated } from '~/Core/Tickets/Domain/Exceptions/TicketNotEscalated';
import { TicketNotOfSource } from '~/Core/Tickets/Domain/Exceptions/TicketNotOfSource';
import { ConfiguredHarnessesLive } from '~/Infrastructure/Shared/HarnessSelector/configured';
import { makeTracingLayer } from '~/Infrastructure/Shared/Tracing/otlp';
import { LedgerFolderLive } from '~/Infrastructure/Tickets/Ledger/folder';
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
  LedgerFolderLive({ process: process.pid, host: hostname() }),
  TracingLive
).pipe(Layer.provideMerge(EngineFileConfigLive), Layer.provideMerge(RepositoryRootLive));

const Concurrency = Schema.Int.check(Schema.isGreaterThan(0));

const ticketSourceFor = (source: Option.Option<TicketSourceTag>) =>
  Effect.gen(function* () {
    const config = yield* EngineConfig;
    const resolved = yield* resolveTicketSource(config.source, Option.getOrUndefined(source));
    return liveTicketSource(resolved, config.defaultKind);
  });

const engine = Command.make(
  'rippls',
  {
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
  }
).pipe(
  // The Project and Source flags scope the Engine and `rippls status`, and may
  // stand before or after the subcommand. `rippls retry` reports to the Source
  // its ticket identity names; a Source flag there must name the same one.
  Command.withSharedFlags({
    source: Flag.choice('source', TicketSourceTag.literals).pipe(Flag.optional),
    project: Flag.string('project').pipe(Flag.withSchema(Project), Flag.optional),
  }),
  Command.withHandler(({ source, project, limit, concurrency, idleTimeout, pollInterval }) =>
    Effect.gen(function* () {
      const ticketSource = yield* ticketSourceFor(source);
      const check = yield* checkConfig;
      return yield* runEngine({
        project: Option.getOrUndefined(project),
        limit: Option.getOrUndefined(limit),
        concurrency,
        idleTimeout,
        pollInterval,
        check,
      }).pipe(Effect.provide(ticketSource));
    })
  )
);

const status = Command.make('status', {}, () =>
  Effect.gen(function* () {
    const { source, project } = yield* engine;
    const ticketSource = yield* ticketSourceFor(source);
    return yield* showStatus({ project: Option.getOrUndefined(project) }).pipe(Effect.provide(ticketSource));
  })
).pipe(Command.withDescription('Print every ticket in scope with its Ticket Status'));

const retry = Command.make(
  'retry',
  {
    ticket: Argument.string('ticket').pipe(
      Argument.withSchema(TicketId),
      Argument.withDescription('The identity of the escalated ticket, such as folder:4')
    ),
  },
  ({ ticket }) =>
    Effect.gen(function* () {
      const { source } = yield* engine;
      const named = yield* retrySourceOf(ticket, Option.getOrUndefined(source));
      const ticketSource = yield* ticketSourceFor(Option.some(named));
      return yield* retryTicket({ ticket }).pipe(Effect.provide(ticketSource));
    })
).pipe(Command.withDescription('Return an escalated ticket to unattended processing'));

const command = engine.pipe(Command.withSubcommands([status, retry]));

export const program = Command.run(command, { version: '0.0.2' }).pipe(
  Effect.provide(AppLive.pipe(Layer.provideMerge(NodeServices.layer)))
);

// Errors whose message is written for the person who ran the command.
const isExplained = (error: unknown): error is Error =>
  error instanceof TicketNotEscalated || error instanceof TicketNotOfSource;

const describeError = (error: unknown) =>
  error instanceof Config.ConfigError ? error.cause.message : isExplained(error) ? error.message : error;

export const run = () =>
  program.pipe(
    Effect.tapError((error) => Effect.logError(describeError(error))),
    NodeRuntime.runMain({ disableErrorReporting: true })
  );

