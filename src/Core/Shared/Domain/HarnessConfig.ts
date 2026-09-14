import { Config, ConfigProvider, Context, DateTime, Duration, Effect, Option, Schema, SchemaGetter } from 'effect';

import { AgentName } from './Properties/AgentName.ts';

export const defaultIdleTimeout = Duration.minutes(5);

export const defaultPollInterval = Duration.seconds(10);

export const idleTimeoutConfig = Config.duration('idleTimeout').pipe(Config.withDefault(defaultIdleTimeout));

export const pollIntervalConfig = Config.duration('pollInterval').pipe(Config.withDefault(defaultPollInterval));

export const AgentPriority = Schema.Int.check(Schema.isGreaterThan(0)).pipe(Schema.brand('AgentPriority'));

export type AgentPriority = typeof AgentPriority.Type;

export const ConfiguredAgent = Schema.Struct({
  name: AgentName,
  priority: Schema.optionalKey(AgentPriority),
});

export type ConfiguredAgent = typeof ConfiguredAgent.Type;

const hasConsistentPriorities = Schema.makeFilter((agents: readonly ConfiguredAgent[]) => {
  const weighted = agents.filter((agent) => agent.priority !== undefined);
  if (weighted.length === 0) {
    return undefined;
  }
  if (weighted.length !== agents.length) {
    return 'Either every agent has a priority or none do';
  }
  const highest = Math.max(...weighted.map((agent) => Number(agent.priority)));
  return weighted.filter((agent) => Number(agent.priority) === highest).length === 1
    ? undefined
    : 'Strict leadership requires a unique highest weight';
});

const ConfiguredAgents = Schema.NonEmptyArray(ConfiguredAgent).check(hasConsistentPriorities);

const FrequencyName = Schema.Literals([
  'YEARLY',
  'MONTHLY',
  'WEEKLY',
  'DAILY',
  'HOURLY',
  'MINUTELY',
  'SECONDLY',
]);

const FrequencyCode = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 }));

const WeekdayName = Schema.Literals(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']);

const IntOrInts = Schema.Union([Schema.Int, Schema.Array(Schema.Int)]);

const ByWeekday = Schema.Union([WeekdayName, Schema.Int, Schema.Array(Schema.Union([WeekdayName, Schema.Int]))]);

const ConfigDate = Schema.Union([Schema.Date, Schema.DateFromString]);

export const RecurrenceRule = Schema.Struct({
  freq: Schema.Union([FrequencyName, FrequencyCode]),
  dtstart: Schema.optionalKey(ConfigDate),
  interval: Schema.optionalKey(Schema.Int),
  wkst: Schema.optionalKey(Schema.Union([WeekdayName, Schema.Int])),
  count: Schema.optionalKey(Schema.Int),
  until: Schema.optionalKey(ConfigDate),
  tzid: Schema.optionalKey(Schema.String),
  bysetpos: Schema.optionalKey(IntOrInts),
  bymonth: Schema.optionalKey(IntOrInts),
  bymonthday: Schema.optionalKey(IntOrInts),
  byyearday: Schema.optionalKey(IntOrInts),
  byweekno: Schema.optionalKey(IntOrInts),
  byweekday: Schema.optionalKey(ByWeekday),
  byhour: Schema.optionalKey(IntOrInts),
  byminute: Schema.optionalKey(IntOrInts),
  bysecond: Schema.optionalKey(IntOrInts),
});

export type RecurrenceRule = typeof RecurrenceRule.Type;

const ClockTime = Schema.String.check(Schema.isPattern(/^([01]\d|2[0-3]):00$/));

const TimeWindowInput = Schema.Struct({
  freq: FrequencyName,
  from: ClockTime,
  to: ClockTime,
  tzid: Schema.optionalKey(Schema.String),
}).check(Schema.makeFilter((window: { readonly from: string; readonly to: string }) =>
  window.from === window.to ? 'from and to must differ' : undefined
));

const hoursInWindow = (fromHour: number, toHour: number): number[] => {
  const hours: number[] = [];
  for (let hour = fromHour; hour !== toHour; hour = (hour + 1) % 24) {
    hours.push(hour);
  }
  return hours.toSorted((left, right) => left - right);
};

const expandTimeWindow = (window: typeof TimeWindowInput.Type): RecurrenceRule => {
  const fromHour = Number.parseInt(window.from.slice(0, 2), 10);
  const toHour = Number.parseInt(window.to.slice(0, 2), 10);
  return {
    freq: window.freq,
    dtstart: DateTime.toDateUtc(DateTime.makeUnsafe(`2026-01-01T${window.from}:00.000Z`)),
    byhour: hoursInWindow(fromHour, toHour),
    tzid: window.tzid ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
};

const TimeWindowRule = TimeWindowInput.pipe(
  Schema.decodeTo(RecurrenceRule, {
    decode: SchemaGetter.transform(expandTimeWindow),
    encode: SchemaGetter.passthrough({ strict: false }),
  })
);

const ScheduledConfigValue = Schema.Struct({
  agents: ConfiguredAgents,
  rrule: RecurrenceRule,
});

const ScheduledFromWindow = Schema.Struct({
  agents: ConfiguredAgents,
  rule: TimeWindowRule,
}).pipe(
  Schema.decodeTo(ScheduledConfigValue, {
    decode: SchemaGetter.transform(({ agents, rule }) => ({ agents, rrule: rule })),
    encode: SchemaGetter.passthrough({ strict: false }),
  })
);

export const ScheduledConfig = Schema.Union([ScheduledFromWindow, ScheduledConfigValue]);

export type ScheduledConfig = typeof ScheduledConfig.Type;

const ScheduledConfigs = Schema.Array(ScheduledConfig);

export const TicketsDir = Schema.NonEmptyString.check(
  Schema.makeFilter((path: string) =>
    path.startsWith('/') ? undefined : 'ticketsDir must be an absolute path'
  )
).pipe(Schema.brand('TicketsDir'));

export type TicketsDir = typeof TicketsDir.Type;

export const TicketSourceTag = Schema.Literals(['folder', 'linear']);

export type TicketSourceTag = typeof TicketSourceTag.Type;

export const TicketSource = Schema.TaggedUnion({
  folder: {
    ticketsDir: TicketsDir,
  },
  linear: {
    teamId: Schema.NonEmptyString,
    apiKeyEnv: Schema.optionalKey(Schema.NonEmptyString),
  },
});

export type TicketSource = typeof TicketSource.Type;

export const HarnessConfigSchema = Schema.Struct({
  agents: ConfiguredAgents,
  schedule: Schema.optionalKey(ScheduledConfigs),
  otlpTraceUrl: Schema.optionalKey(Schema.NonEmptyString),
  idleTimeout: Schema.optionalKey(Schema.DurationFromString),
  pollInterval: Schema.optionalKey(Schema.DurationFromString),
  source: Schema.optionalKey(TicketSource),
});

export type HarnessConfigValue = typeof HarnessConfigSchema.Type;

export type HarnessFileConfig = typeof HarnessConfigSchema.Encoded;

export const defaultHarnessConfig: HarnessConfigValue = {
  agents: [{ name: 'Codex' }, { name: 'Cursor' }, { name: 'Claude' }, { name: 'OpenCode' }],
  schedule: [],
  idleTimeout: defaultIdleTimeout,
  pollInterval: defaultPollInterval,
};

export class HarnessConfig extends Context.Service<HarnessConfig, HarnessConfigValue>()('HarnessConfig') {}

const asConfigInput = (value: unknown): unknown => {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(asConfigInput);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, asConfigInput(nested)]));
  }
  return value;
};

export const harnessConfigProvider = (input: unknown) => ConfigProvider.fromUnknown(asConfigInput(input));

export const harnessConfig: Config.Config<HarnessConfigValue> = Config.all({
  agents: Config.schema(ConfiguredAgents, 'agents'),
  schedule: Config.schema(ScheduledConfigs, 'schedule').pipe(Config.withDefault([])),
  otlpTraceUrl: Config.nonEmptyString('otlpTraceUrl').pipe(Config.option),
  source: Config.schema(TicketSource, 'source').pipe(Config.option),
  idleTimeout: idleTimeoutConfig,
  pollInterval: pollIntervalConfig,
}).pipe(
  Config.map(({ otlpTraceUrl, source, ...rest }) => {
    const withTrace = Option.match(otlpTraceUrl, {
      onNone: () => rest,
      onSome: (url) => ({ ...rest, otlpTraceUrl: url }),
    });
    return Option.match(source, {
      onNone: () => withTrace,
      onSome: (value) => ({ ...withTrace, source: value }),
    });
  }),
  Config.withDefault(defaultHarnessConfig)
);

export function resolveTicketSource(
  configured: TicketSource | undefined,
  override: 'folder'
): Effect.Effect<Extract<TicketSource, { readonly _tag: 'folder' }>, Config.ConfigError>;
export function resolveTicketSource(
  configured: TicketSource | undefined,
  override: 'linear'
): Effect.Effect<Extract<TicketSource, { readonly _tag: 'linear' }>, Config.ConfigError>;
export function resolveTicketSource(
  configured: TicketSource | undefined,
  override?: TicketSourceTag
): Effect.Effect<TicketSource, Config.ConfigError>;
export function resolveTicketSource(
  configured: TicketSource | undefined,
  override?: TicketSourceTag
): Effect.Effect<TicketSource, Config.ConfigError> {
  if ((override === undefined || configured?._tag === override) && configured !== undefined) {
    return Effect.succeed(configured);
  }
  return Config.schema(TicketSource, 'source').pipe(
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromUnknown(override === undefined ? {} : { source: { _tag: override } })
    )
  );
}
