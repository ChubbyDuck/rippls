import { createRequire } from 'node:module';
import { DateTime } from 'effect';
import type { Frequency, Options } from 'rrule';

import type { RecurrenceRule } from '~/Core/Shared/Domain/HarnessConfig';

const { RRule } = createRequire(import.meta.url)('rrule') as typeof import('rrule');

const toFrequency = (freq: RecurrenceRule['freq']): Frequency => (typeof freq === 'string' ? RRule[freq] : freq);

const toWeekday = (weekday: 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU' | number) =>
  typeof weekday === 'string' ? RRule[weekday] : weekday;

const asMutable = <T>(value: T | readonly T[]): T | T[] => (Array.isArray(value) ? [...value] : (value as T));

const toRRuleOptions = (rule: RecurrenceRule): Partial<Options> => ({
  freq: toFrequency(rule.freq),
  ...(rule.dtstart === undefined ? {} : { dtstart: rule.dtstart }),
  ...(rule.interval === undefined ? {} : { interval: rule.interval }),
  ...(rule.wkst === undefined ? {} : { wkst: toWeekday(rule.wkst) }),
  ...(rule.count === undefined ? {} : { count: rule.count }),
  ...(rule.until === undefined ? {} : { until: rule.until }),
  ...(rule.tzid === undefined ? {} : { tzid: rule.tzid }),
  ...(rule.bysetpos === undefined ? {} : { bysetpos: asMutable(rule.bysetpos) }),
  ...(rule.bymonth === undefined ? {} : { bymonth: asMutable(rule.bymonth) }),
  ...(rule.bymonthday === undefined ? {} : { bymonthday: asMutable(rule.bymonthday) }),
  ...(rule.byyearday === undefined ? {} : { byyearday: asMutable(rule.byyearday) }),
  ...(rule.byweekno === undefined ? {} : { byweekno: asMutable(rule.byweekno) }),
  ...(rule.byweekday === undefined ? {} : { byweekday: asMutable(rule.byweekday) }),
  ...(rule.byhour === undefined ? {} : { byhour: asMutable(rule.byhour) }),
  ...(rule.byminute === undefined ? {} : { byminute: asMutable(rule.byminute) }),
  ...(rule.bysecond === undefined ? {} : { bysecond: asMutable(rule.bysecond) }),
});

const toFloatingInZone = (now: Date, tzid: string): Date => {
  const parts = DateTime.toParts(DateTime.makeZonedUnsafe(now, { timeZone: tzid }));
  return DateTime.toDateUtc(
    DateTime.makeUnsafe({
      year: parts.year,
      month: parts.month,
      day: parts.day,
      hour: parts.hour,
      minute: parts.minute,
      second: parts.second,
      millisecond: parts.millisecond,
    })
  );
};

const occurrenceEnd = (start: Date, rule: RecurrenceRule, freq: Frequency, interval: number): Date => {
  const datetime = DateTime.makeUnsafe(start);
  if (rule.byhour !== undefined) {
    const hours = freq === RRule.HOURLY ? interval : 1;
    return DateTime.toDateUtc(DateTime.add(datetime, { hours }));
  }
  switch (freq) {
    case RRule.SECONDLY:
      return DateTime.toDateUtc(DateTime.add(datetime, { seconds: interval }));
    case RRule.MINUTELY:
      return DateTime.toDateUtc(DateTime.add(datetime, { minutes: interval }));
    case RRule.HOURLY:
      return DateTime.toDateUtc(DateTime.add(datetime, { hours: interval }));
    case RRule.DAILY:
      return DateTime.toDateUtc(DateTime.add(datetime, { days: interval }));
    case RRule.WEEKLY:
      return DateTime.toDateUtc(DateTime.add(datetime, { weeks: interval }));
    case RRule.MONTHLY:
      return DateTime.toDateUtc(DateTime.add(datetime, { months: interval }));
    case RRule.YEARLY:
      return DateTime.toDateUtc(DateTime.add(datetime, { years: interval }));
  }
};

export const recurrenceCovers = (rule: RecurrenceRule, now: Date): boolean => {
  const at = rule.tzid === undefined ? now : toFloatingInZone(now, rule.tzid);
  const rrule = new RRule(toRRuleOptions({ ...rule, tzid: undefined }));
  const last = rrule.before(at, true);
  return last !== null && at.getTime() < occurrenceEnd(last, rule, rrule.options.freq, rrule.options.interval).getTime();
};
