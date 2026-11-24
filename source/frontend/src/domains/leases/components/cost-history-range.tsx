// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Alert,
  DateRangePicker,
  DateRangePickerProps,
} from "@cloudscape-design/components";
import { DateTime, DurationLikeObject } from "luxon";

import { CostHistoryRange } from "@amzn/innovation-sandbox-frontend/domains/leases/types";

/**
 * The whole series, named in the dropdown rather than reachable only by clearing
 * the picker. Every option the picker takes is a duration, so the widest one the
 * lease can have stands in for "all of it" and the lookback is dropped by key
 * before the range is applied. The duration is the fallback and not the intent: a
 * decade of lookback reads the same rows as no bound at all.
 */
export const WHOLE_LEASE: DateRangePickerProps.RelativeOption = {
  key: "whole-lease",
  type: "relative",
  amount: 10,
  unit: "year",
};

// The whole lease first, being what the section opens on and what most readers
// want; the narrower windows widen from there.
const RELATIVE_RANGES: DateRangePickerProps.RelativeOption[] = [
  WHOLE_LEASE,
  { key: "last-24-hours", type: "relative", amount: 24, unit: "hour" },
  { key: "last-7-days", type: "relative", amount: 7, unit: "day" },
  { key: "last-30-days", type: "relative", amount: 30, unit: "day" },
];

/** The picker's units are singular, and every label that names one reads plural. */
const pluralizedUnit = (
  unit: DateRangePickerProps.TimeUnit,
  amount: number,
): string => (amount === 1 ? unit : `${unit}s`);

const RANGE_I18N: DateRangePickerProps.I18nStrings = {
  relativeModeTitle: "Relative range",
  absoluteModeTitle: "Absolute range",
  relativeRangeSelectionHeading: "Choose a range",
  customRelativeRangeOptionLabel: "Custom range",
  customRelativeRangeOptionDescription: "Set a custom range in the past",
  customRelativeRangeUnitLabel: "Unit of time",
  customRelativeRangeDurationLabel: "Duration",
  customRelativeRangeDurationPlaceholder: "Enter a duration",
  startDateLabel: "Start date",
  startTimeLabel: "Start time",
  endDateLabel: "End date",
  endTimeLabel: "End time",
  dateTimeConstraintText: "Range must be in YYYY/MM/DD hh:mm.",
  clearButtonLabel: "Clear",
  cancelButtonLabel: "Cancel",
  applyButtonLabel: "Apply",
  todayAriaLabel: "Today",
  nextMonthAriaLabel: "Next month",
  previousMonthAriaLabel: "Previous month",
  formatUnit: pluralizedUnit,
  formatRelativeRange: (range) =>
    range.key === WHOLE_LEASE.key
      ? "Whole lease"
      : `Last ${range.amount} ${pluralizedUnit(range.unit, range.amount)}`,
};

/**
 * The lookback a relative option names. Spelled out rather than derived from the
 * unit, because the picker's units are singular and Luxon's are plural.
 */
function lookbackOf(unit: DateRangePickerProps.TimeUnit, amount: number) {
  const durations: Record<DateRangePickerProps.TimeUnit, DurationLikeObject> = {
    second: { seconds: amount },
    minute: { minutes: amount },
    hour: { hours: amount },
    day: { days: amount },
    week: { weeks: amount },
    month: { months: amount },
    year: { years: amount },
  };
  return durations[unit];
}

/**
 * The picked range as query parameters, or undefined for the whole series -- which
 * is both the whole-lease option and a cleared picker. A relative range is resolved
 * to an instant here rather than at request time, so that browsing "last 24 hours"
 * reads one fixed span instead of a span whose lower bound slides on every render.
 *
 * A relative range sends no upper bound and the API fills it with now, so the
 * newest observation always lands inside it. `now` is when a relative range
 * reaches back from: the moment it is picked, unless the caller reads it against
 * data read earlier.
 */
export function toCostHistoryRange(
  value: DateRangePickerProps.Value | null,
  now: DateTime = DateTime.now(),
): CostHistoryRange | undefined {
  if (value === null) {
    return undefined;
  }
  if (value.type === "absolute") {
    // The picker reports wall-clock times in the browser's zone; the API compares
    // instants. The picked end is included and the API's upper bound is not, so
    // the API is sent the millisecond after it.
    const from = asInstant(value.startDate);
    const before = asInstant(value.endDate, { milliseconds: 1 });
    return from === undefined || before === undefined
      ? undefined
      : { afterTimestamp: from, beforeTimestamp: before };
  }
  if (value.key === WHOLE_LEASE.key) {
    return undefined;
  }
  const from = asInstant(
    now.minus(lookbackOf(value.unit, value.amount)).toISO(),
  );
  return from === undefined ? undefined : { afterTimestamp: from };
}

/**
 * The last instant a range includes, the millisecond before its exclusive end, or
 * undefined where it runs to now. The spend chart and the token panel end there.
 */
export function lastIncludedInstant(
  range: CostHistoryRange | undefined,
): string | undefined {
  return range?.beforeTimestamp === undefined
    ? undefined
    : asInstant(range.beforeTimestamp, { milliseconds: -1 });
}

function asInstant(
  wallClock: string | null,
  offset: DurationLikeObject = {},
): string | undefined {
  const parsed = DateTime.fromISO(wallClock ?? "");
  return parsed.isValid ? parsed.plus(offset).toUTC().toISO() : undefined;
}

/**
 * Checked here rather than left to the API: an inverted range reads back as a lease
 * that spent nothing over it, which is not what was asked for.
 */
export function isValidRange(
  value: DateRangePickerProps.Value | null,
): DateRangePickerProps.ValidationResult {
  if (value === null) {
    return { valid: false, errorMessage: "Select a range." };
  }
  if (value.type === "relative") {
    return Number.isNaN(value.amount) || value.amount <= 0
      ? { valid: false, errorMessage: "Enter a duration of one or more." }
      : { valid: true };
  }
  const from = asInstant(value.startDate);
  const to = asInstant(value.endDate);
  if (from === undefined || to === undefined) {
    return {
      valid: false,
      errorMessage: "Set both a start and an end date and time.",
    };
  }
  return from > to
    ? { valid: false, errorMessage: "The start must not be after the end." }
    : { valid: true };
}

type CostRangePickerProps = {
  value: DateRangePickerProps.Value | null;
  onChange: (value: DateRangePickerProps.Value | null) => void;
  /** Names the chart it ranges, since the page carries more than one picker. */
  ariaLabel: string;
};

/** The range picker the cost section and the Bedrock token panel each carry. */
export const CostRangePicker = ({
  value,
  onChange,
  ariaLabel,
}: CostRangePickerProps) => (
  <DateRangePicker
    value={value}
    ariaLabel={ariaLabel}
    onChange={({ detail }) => onChange(detail.value)}
    relativeOptions={RELATIVE_RANGES}
    i18nStrings={RANGE_I18N}
    placeholder="Whole lease"
    timeInputFormat="hh:mm"
    isValidRange={isValidRange}
    expandToViewport
  />
);

type PartialRangeAlertProps = {
  header: string;
  /** What the dated line says is shown, "usage" or "breaches". */
  subject: string;
  /** The oldest row the load reached, if any reached it. */
  loadedSince?: string;
  /**
   * Said instead of the dated line where no row arrived to date it from, or its
   * date does not parse.
   */
  fallback: string;
};

/** The warning a section shows where its load stopped short of its range. */
export const PartialRangeAlert = ({
  header,
  subject,
  loadedSince,
  fallback,
}: PartialRangeAlertProps) => {
  const since =
    loadedSince === undefined ? undefined : DateTime.fromISO(loadedSince);
  return (
    <Alert type="warning" header={header}>
      {since?.isValid
        ? `Showing ${subject} since ${since.toLocaleString(DateTime.DATE_MED)}; pick a narrower range to see earlier.`
        : fallback}
    </Alert>
  );
};
