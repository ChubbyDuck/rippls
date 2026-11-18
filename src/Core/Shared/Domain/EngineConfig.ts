import { Config, ConfigProvider, Context, DateTime, Duration, Effect, Option, Schema, SchemaGetter } from 'effect';

import { Hitl } from '../../Tickets/Domain/Entities/Ticket/properties/Hitl.ts';
import { Project } from '../../Tickets/Domain/Entities/Ticket/properties/Project.ts';
import { defaultTicketKind, TicketKind } from '../../Tickets/Domain/Entities/Ticket/properties/TicketKind.ts';
import { PromptTemplate } from '../../Tickets/Domain/Services/promptTemplate.ts';
import type { ModelDemand } from '../Ports/Harness.ts';

import { HarnessName } from './Properties/HarnessName.ts';

export const defaultIdleTimeout = Duration.minutes(5);

export const defaultPollInterval = Duration.seconds(10);

export const idleTimeoutConfig = Config.duration('idleTimeout').pipe(Config.withDefault(defaultIdleTimeout));

export const pollIntervalConfig = Config.duration('pollInterval').pipe(Config.withDefault(defaultPollInterval));

export const defaultKindConfig = Config.schema(TicketKind, 'defaultKind').pipe(Config.withDefault(defaultTicketKind));

export const HarnessPriority = Schema.Int.check(Schema.isGreaterThan(0)).pipe(Schema.brand('HarnessPriority'));

export type HarnessPriority = typeof HarnessPriority.Type;

export const ConfiguredHarness = Schema.Struct({
  name: HarnessName,
  priority: Schema.optionalKey(HarnessPriority),
});

export type ConfiguredHarness = typeof ConfiguredHarness.Type;

const hasConsistentPriorities = Schema.makeFilter((harnesses: readonly ConfiguredHarness[]) => {
  const weighted = harnesses.filter((harness) => harness.priority !== undefined);
  if (weighted.length === 0) {
    return undefined;
  }
  if (weighted.length !== harnesses.length) {
    return 'Either every harness has a priority or none do';
  }
  const highest = Math.max(...weighted.map((harness) => Number(harness.priority)));
  return weighted.filter((harness) => Number(harness.priority) === highest).length === 1
    ? undefined
    : 'Strict leadership requires a unique highest weight';
});

const ConfiguredHarnesses = Schema.NonEmptyArray(ConfiguredHarness).check(hasConsistentPriorities);

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
  harnesses: ConfiguredHarnesses,
  rrule: RecurrenceRule,
});

const ScheduledFromWindow = Schema.Struct({
  harnesses: ConfiguredHarnesses,
  rule: TimeWindowRule,
}).pipe(
  Schema.decodeTo(ScheduledConfigValue, {
    decode: SchemaGetter.transform(({ harnesses, rule }) => ({ harnesses, rrule: rule })),
    encode: SchemaGetter.passthrough({ strict: false }),
  })
);

export const ScheduledConfig = Schema.Union([ScheduledFromWindow, ScheduledConfigValue]);

export type ScheduledConfig = typeof ScheduledConfig.Type;

const ScheduledConfigs = Schema.Array(ScheduledConfig);

export const TicketsDir = Schema.NonEmptyString.pipe(Schema.brand('TicketsDir'));

export type TicketsDir = typeof TicketsDir.Type;

export const TicketSourceTag = Schema.Literals(['folder', 'linear']);

export type TicketSourceTag = typeof TicketSourceTag.Type;

export const TicketSourceConfig = Schema.TaggedUnion({
  folder: {
    ticketsDir: TicketsDir,
    // The HITL of a folder ticket that states no HITL, no marker, and no Ticket
    // Kind, and no Marker. `yes` unless set; `no` suits a folder where every file is ready.
    defaultHitl: Schema.optionalKey(Hitl),
  },
  linear: {
    teamId: Schema.NonEmptyString,
    apiKeyEnv: Schema.optionalKey(Schema.NonEmptyString),
  },
});

export type TicketSourceConfig = typeof TicketSourceConfig.Type;

// The repository's own check command, which the Engine runs in the Ticket Worktree
// after the Strategy succeeds and before the merge. Its exit code is the verdict.
// A Project may override the command; a ticket without a Project, or of a Project
// without an override, uses `command`. With no command the check is skipped.
const CheckCommand = Schema.NonEmptyString.check(Schema.isTrimmed());

const FixAttempts = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const CheckFileConfig = Schema.Struct({
  command: Schema.optionalKey(CheckCommand),
  projects: Schema.optionalKey(Schema.Record(Project, CheckCommand)),
  timeLimit: Schema.optionalKey(Schema.DurationFromString),
  fixAttempts: Schema.optionalKey(FixAttempts),
  fixPrompt: Schema.optionalKey(Schema.NonEmptyString),
});

export interface CheckConfig {
  readonly command?: string;
  readonly projects: Readonly<Record<Project, string>>;
  readonly timeLimit: Duration.Duration;
  readonly fixAttempts: number;
  readonly fixPrompt: string;
}

const defaultCheckTimeLimit = Duration.minutes(10);

const defaultFixAttempts = 1;

export const defaultFixPrompt =
  "The repository's check command failed on the work in this worktree. " +
  'Read its output below, find the cause, and fix the work so that the command passes. ' +
  'Leave the fix in this worktree.';

export const defaultCheckConfig: CheckConfig = {
  projects: {},
  timeLimit: defaultCheckTimeLimit,
  fixAttempts: defaultFixAttempts,
  fixPrompt: defaultFixPrompt,
};

export const checkConfig: Config.Config<CheckConfig> = Config.schema(CheckFileConfig, 'check').pipe(
  Config.map((check) => ({ ...defaultCheckConfig, ...check })),
  Config.withDefault(defaultCheckConfig)
);

// The check command for a ticket: the override of its Project, or the default.
export const checkCommandOf = (check: CheckConfig, project: Project | undefined): string | undefined =>
  (project === undefined ? undefined : check.projects[project]) ?? check.command;

// The model demand of a Harness run, as config writes it.
const ModelDemandConfig = Schema.Struct({
  tier: Schema.optionalKey(Schema.Literals(['low', 'mid', 'high'])),
  fast: Schema.optionalKey(Schema.Boolean),
  generation: Schema.optionalKey(Schema.Literals(['current', 'previous'])),
});

// The prompt the Engine sends when a Ticket Worktree is dirty after the check, so
// that the work is committed whichever skill did it. The prompt is a template over
// the ticket; a model demand that is set replaces the default one whole.
export const CommitFileConfig = Schema.Struct({
  prompt: Schema.optionalKey(PromptTemplate),
  model: Schema.optionalKey(ModelDemandConfig),
});

export interface CommitConfig {
  readonly prompt: string;
  readonly model: ModelDemand;
}

export const defaultCommitPrompt =
  'Commit all the work in this worktree: every change, and every new file that Git does not ignore. ' +
  'Write a conventional commit message that names ticket {{id}}.';

export const defaultCommitConfig: CommitConfig = {
  prompt: defaultCommitPrompt,
  model: { fast: true, tier: 'low' },
};

export const commitConfig: Config.Config<CommitConfig> = Config.schema(CommitFileConfig, 'commit').pipe(
  Config.map((commit) => ({ ...defaultCommitConfig, ...commit })),
  Config.withDefault(defaultCommitConfig)
);

export const EngineConfigSchema = Schema.Struct({
  harnesses: ConfiguredHarnesses,
  schedule: Schema.optionalKey(ScheduledConfigs),
  otlpTraceUrl: Schema.optionalKey(Schema.NonEmptyString),
  idleTimeout: Schema.optionalKey(Schema.DurationFromString),
  pollInterval: Schema.optionalKey(Schema.DurationFromString),
  defaultKind: Schema.optionalKey(TicketKind),
  source: Schema.optionalKey(TicketSourceConfig),
  check: Schema.optionalKey(CheckFileConfig),
  commit: Schema.optionalKey(CommitFileConfig),
});

export type EngineConfigValue = typeof EngineConfigSchema.Type;

export type EngineFileConfig = typeof EngineConfigSchema.Encoded;

export const defaultEngineConfig: EngineConfigValue = {
  harnesses: [{ name: 'Codex' }, { name: 'Cursor' }, { name: 'Claude' }, { name: 'OpenCode' }],
  schedule: [],
  idleTimeout: defaultIdleTimeout,
  pollInterval: defaultPollInterval,
  defaultKind: defaultTicketKind,
};

export class EngineConfig extends Context.Service<EngineConfig, EngineConfigValue>()('EngineConfig') {}

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

export const engineConfigProvider = (input: unknown) => ConfigProvider.fromUnknown(asConfigInput(input));

export const engineConfig: Config.Config<EngineConfigValue> = Config.all({
  harnesses: Config.schema(ConfiguredHarnesses, 'harnesses'),
  schedule: Config.schema(ScheduledConfigs, 'schedule').pipe(Config.withDefault([])),
  otlpTraceUrl: Config.nonEmptyString('otlpTraceUrl').pipe(Config.option),
  source: Config.schema(TicketSourceConfig, 'source').pipe(Config.option),
  idleTimeout: idleTimeoutConfig,
  pollInterval: pollIntervalConfig,
  defaultKind: defaultKindConfig,
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
  Config.withDefault(defaultEngineConfig)
);

export function resolveTicketSource(
  configured: TicketSourceConfig | undefined,
  override: 'folder'
): Effect.Effect<Extract<TicketSourceConfig, { readonly _tag: 'folder' }>, Config.ConfigError>;
export function resolveTicketSource(
  configured: TicketSourceConfig | undefined,
  override: 'linear'
): Effect.Effect<Extract<TicketSourceConfig, { readonly _tag: 'linear' }>, Config.ConfigError>;
export function resolveTicketSource(
  configured: TicketSourceConfig | undefined,
  override?: TicketSourceTag
): Effect.Effect<TicketSourceConfig, Config.ConfigError>;
export function resolveTicketSource(
  configured: TicketSourceConfig | undefined,
  override?: TicketSourceTag
): Effect.Effect<TicketSourceConfig, Config.ConfigError> {
  if ((override === undefined || configured?._tag === override) && configured !== undefined) {
    return Effect.succeed(configured);
  }
  return Config.schema(TicketSourceConfig, 'source').pipe(
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromUnknown(override === undefined ? {} : { source: { _tag: override } })
    )
  );
}
