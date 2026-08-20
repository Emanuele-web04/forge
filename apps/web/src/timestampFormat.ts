import { type TimestampFormat } from "./appSettings";

export function getTimestampFormatOptions(
  timestampFormat: TimestampFormat,
  includeSeconds: boolean,
): Intl.DateTimeFormatOptions {
  const baseOptions: Intl.DateTimeFormatOptions = {
    hour: "numeric",
    minute: "2-digit",
    ...(includeSeconds ? { second: "2-digit" } : {}),
  };

  if (timestampFormat === "locale") {
    return baseOptions;
  }

  return {
    ...baseOptions,
    hour12: timestampFormat === "12-hour",
  };
}

const timestampFormatterCache = new Map<string, Intl.DateTimeFormat>();

function getTimestampFormatter(
  timestampFormat: TimestampFormat,
  includeSeconds: boolean,
): Intl.DateTimeFormat {
  const cacheKey = `${timestampFormat}:${includeSeconds ? "seconds" : "minutes"}`;
  const cachedFormatter = timestampFormatterCache.get(cacheKey);
  if (cachedFormatter) {
    return cachedFormatter;
  }

  const formatter = new Intl.DateTimeFormat(
    undefined,
    getTimestampFormatOptions(timestampFormat, includeSeconds),
  );
  timestampFormatterCache.set(cacheKey, formatter);
  return formatter;
}

export function formatTimestamp(isoDate: string, timestampFormat: TimestampFormat): string {
  return getTimestampFormatter(timestampFormat, true).format(new Date(isoDate));
}

export function formatShortTimestamp(isoDate: string, timestampFormat: TimestampFormat): string {
  return getTimestampFormatter(timestampFormat, false).format(new Date(isoDate));
}

const dayLabelFormatterCache = new Map<string, Intl.DateTimeFormat>();

function getDayLabelFormatter(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const cacheKey = JSON.stringify(options);
  const cachedFormatter = dayLabelFormatterCache.get(cacheKey);
  if (cachedFormatter) {
    return cachedFormatter;
  }

  const formatter = new Intl.DateTimeFormat(undefined, options);
  dayLabelFormatterCache.set(cacheKey, formatter);
  return formatter;
}

function isSameCalendarDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

const DAY_IN_MS = 24 * 60 * 60 * 1000;

/** Local-midnight day difference, so "yesterday 23:59 → today 00:01" counts as one day apart. */
function calendarDaysBetween(from: Date, to: Date): number {
  const fromMidnight = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const toMidnight = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((toMidnight.getTime() - fromMidnight.getTime()) / DAY_IN_MS);
}

/**
 * Day-aware message timestamp: same-day messages show just the clock time;
 * messages from another day within the past week are prefixed with the weekday
 * name, and anything older with a short date (plus year once it differs).
 */
export function formatDayAwareTimestamp(
  isoDate: string,
  timestampFormat: TimestampFormat,
  now: Date = new Date(),
): string {
  const date = new Date(isoDate);
  const time = getTimestampFormatter(timestampFormat, false).format(date);
  if (isSameCalendarDay(date, now)) {
    return time;
  }

  const daysAgo = calendarDaysBetween(date, now);
  const dayLabel =
    daysAgo > 0 && daysAgo < 7
      ? getDayLabelFormatter({ weekday: "long" }).format(date)
      : getDayLabelFormatter({
          month: "short",
          day: "numeric",
          ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
        }).format(date);
  return `${dayLabel} ${time}`;
}
